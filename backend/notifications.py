"""Durable decision outbox. Preview by default; no automatic ambiguous SMTP retry."""
import asyncio
from email.message import EmailMessage
import logging
import os
import re
import smtplib
import ssl
from uuid import uuid4

from firebase_admin import firestore
from google.cloud.firestore_v1.base_query import FieldFilter
from starlette.concurrency import run_in_threadpool
from fastapi import HTTPException

logger = logging.getLogger('nampol.notifications')


def message(reference, status):
    if not re.fullmatch(r'NAMPOL-[0-9]{4}-[A-Z0-9]{6,32}', reference or '') or status not in ('Approved', 'Denied'):
        raise ValueError('Invalid notification metadata')
    return (f'NamPol application {reference}: {status}',
            f'Application reference: {reference}\nStatus changed from Under Review to {status}.\n'
            'Sign in to your NamPol applicant dashboard to view the current status.\n')


class PreviewMail:
    outcome = 'previewed'
    def send(self, recipient, subject, body, notification_id):
        # Intentionally do not log/store the email address or content. No network.
        return


class SmtpMail:
    outcome = 'sent'
    def __init__(self):
        self.host = os.environ.get('NAMPOL_SMTP_HOST', '')
        self.port = int(os.environ.get('NAMPOL_SMTP_PORT', '587'))
        self.sender = os.environ.get('NAMPOL_SMTP_FROM', '')
        self.username = os.environ.get('NAMPOL_SMTP_USERNAME', '')
        self.password = os.environ.get('NAMPOL_SMTP_PASSWORD', '')
        if (not self.host or self.port not in (465, 587) or not self.username or not self.password
                or not re.fullmatch(r'[^\s<>\r\n@]+@[^\s<>\r\n@]+', self.sender)):
            raise ValueError('Trusted SMTP configuration required')

    def send(self, recipient, subject, body, notification_id):
        email = EmailMessage()
        email['From'] = self.sender; email['To'] = recipient; email['Subject'] = subject
        email['Message-ID'] = f'<nampol-{notification_id}@{self.sender.split("@")[1]}>'
        email.set_content(body)
        context = ssl.create_default_context()
        if self.port == 465:
            with smtplib.SMTP_SSL(self.host, self.port, timeout=15, context=context) as smtp:
                smtp.login(self.username, self.password); smtp.send_message(email)
        else:
            with smtplib.SMTP(self.host, self.port, timeout=15) as smtp:
                smtp.ehlo(); smtp.starttls(context=context); smtp.ehlo()
                smtp.login(self.username, self.password); smtp.send_message(email)


class NotificationDispatcher:
    def __init__(self, client, user_lookup, transport):
        self.client, self.user_lookup, self.transport = client, user_lookup, transport

    def status(self, actor, application_id, authorization):
        application = authorization.records.read('applications', application_id)
        if not application: raise HTTPException(404, 'Resource not found.')
        grant = authorization.administrator(actor, application.get('region'))
        self.client.collection('auditLogs').document(uuid4().hex).create({
            'actorUid': actor.uid, 'actorRole': grant['role'], 'action': 'NOTIFICATION_STATUS_VIEWED',
            'applicationId': application_id, 'region': application['region'], 'timestamp': firestore.SERVER_TIMESTAMP})
        if application.get('status') not in ('Approved', 'Denied'):
            return {'state': 'not_queued'}
        job = self.client.collection('notificationOutbox').document(application_id + '__' + application['status']).get().to_dict()
        if not job: return {'state': 'not_queued'}
        if (job.get('applicantId') != application.get('applicantId') or job.get('region') != application.get('region')
                or job.get('applicationReference') != application.get('applicationReference')):
            raise HTTPException(409, 'Notification does not match this application.')
        result = {'state': job['state'], 'status': job['status']}
        if job['state'] == 'previewed':
            subject, body = message(job['applicationReference'], job['status'])
            result['preview'] = {'subject': subject, 'body': body}
        return result

    def deliver(self, notification_id):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,170}', notification_id):
            raise ValueError('Invalid notification identifier')
        reference = self.client.collection('notificationOutbox').document(notification_id)
        attempt = uuid4().hex

        @firestore.transactional
        def claim(transaction):
            job = reference.get(transaction=transaction).to_dict()
            if not job or job.get('state') != 'pending':
                return None
            application = self.client.collection('applications').document(job['applicationId']).get(transaction=transaction).to_dict()
            action = 'APPLICATION_APPROVED' if job.get('status') == 'Approved' else 'APPLICATION_DENIED'
            audit = self.client.collection('auditLogs').document(job['applicationId'] + '__' + action).get(transaction=transaction).to_dict()
            binding = self.client.collection('serverApplicationDocumentBindings').document(job['applicationId']).get(transaction=transaction).to_dict()
            if (not application or not audit or not binding or job.get('status') not in ('Approved', 'Denied')
                    or notification_id != job['applicationId'] + '__' + job['status']
                    or application.get('status') != job['status'] or application.get('applicantId') != job.get('applicantId')
                    or application.get('applicationReference') != job.get('applicationReference')
                    or application.get('region') != job.get('region')
                    or application.get('reviewedAt') != job.get('createdAt')
                    or audit.get('applicationId') != job['applicationId'] or audit.get('action') != action
                    or audit.get('adminId') != application.get('reviewedBy')
                    or binding.get('ownerUid') != job['applicantId'] or binding.get('setId') != application.get('documentSetId')):
                raise ValueError('Invalid outbox source')
            transaction.update(reference, {'state': 'processing', 'attemptId': attempt, 'claimedAt': firestore.SERVER_TIMESTAMP})
            transaction.create(self.client.collection('auditLogs').document(notification_id + '__' + attempt + '__started'),
                               self.event(job, notification_id, 'NOTIFICATION_DELIVERY_STARTED'))
            return job

        job = claim(self.client.transaction())
        if job is None:
            return 'unchanged'
        try:
            subject, body = message(job['applicationReference'], job['status'])
            user = self.user_lookup(job['applicantId'])
            recipient = user.email
            if (user.disabled or not user.email_verified or not isinstance(recipient, str)
                    or not re.fullmatch(r'[^\s<>\r\n@]+@[^\s<>\r\n@]+', recipient)):
                raise ValueError('Recipient needs operator verification')
        except Exception:
            self.finish(reference, job, notification_id, attempt, 'blocked', 'NOTIFICATION_BLOCKED')
            return 'blocked'
        try:
            self.transport.send(recipient, subject, body, notification_id)
        except Exception:
            # SMTP may have accepted the email before the connection failed.
            # Never retry an uncertain delivery without manual reconciliation.
            self.finish(reference, job, notification_id, attempt, 'delivery_unknown', 'NOTIFICATION_DELIVERY_UNKNOWN')
            return 'delivery_unknown'
        state = self.transport.outcome
        self.finish(reference, job, notification_id, attempt, state,
                    'NOTIFICATION_SENT' if state == 'sent' else 'NOTIFICATION_PREVIEWED')
        return state

    @staticmethod
    def event(job, notification_id, action):
        return {'actorUid': 'system:notifications', 'action': action, 'applicationId': job['applicationId'],
                'notificationId': notification_id, 'region': job['region'], 'timestamp': firestore.SERVER_TIMESTAMP}

    def finish(self, reference, job, notification_id, attempt, state, action):
        @firestore.transactional
        def save(transaction):
            current = reference.get(transaction=transaction).to_dict()
            if not current or current.get('state') != 'processing' or current.get('attemptId') != attempt:
                raise ValueError('Delivery claim changed')
            transaction.update(reference, {'state': state, 'completedAt': firestore.SERVER_TIMESTAMP})
            transaction.create(self.client.collection('auditLogs').document(notification_id + '__' + attempt + '__' + state),
                               self.event(job, notification_id, action))
        save(self.client.transaction())

    def retry_blocked(self, notification_id):
        """Trusted IT-only operation; never exposed as a browser endpoint.

        Only proven pre-send failures can be retried. Sent, processing and
        uncertain deliveries require external reconciliation, never a reset.
        """
        reference = self.client.collection('notificationOutbox').document(notification_id)
        @firestore.transactional
        def retry(transaction):
            job = reference.get(transaction=transaction).to_dict()
            if not job or job.get('state') != 'blocked':
                raise ValueError('Only blocked pre-send jobs can be retried')
            transaction.update(reference, {'state': 'pending'})
            transaction.create(self.client.collection('auditLogs').document(uuid4().hex),
                {**self.event(job, notification_id, 'NOTIFICATION_RETRY_SCHEDULED'), 'actorUid': 'IT_OPERATOR_ADC'})
        retry(self.client.transaction())

    def drain(self):
        # Equality-only query needs no composite index. Claims protect multiple instances.
        query = self.client.collection('notificationOutbox').where(filter=FieldFilter('state', '==', 'pending')).limit(20)
        for snapshot in query.stream():
            try:
                self.deliver(snapshot.id)
            except Exception:
                # No raw SDK/provider errors, recipients or credentials in logs.
                logger.warning('Notification processing requires operator attention.')

    async def run(self):
        while True:
            try:
                await run_in_threadpool(self.drain)
            except Exception:
                logger.warning('Notification queue temporarily unavailable.')
            await asyncio.sleep(15)


def configured_transport():
    mode = os.environ.get('NAMPOL_EMAIL_MODE', 'preview')
    if mode == 'preview': return PreviewMail()
    if mode == 'disabled': return None
    if mode == 'smtp' and os.environ.get('NAMPOL_APPROVED_EMAIL_DELIVERY') == 'true': return SmtpMail()
    raise ValueError('Email mode is invalid or real delivery has not been explicitly approved.')
