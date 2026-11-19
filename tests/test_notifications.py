"""Offline email/outbox tests; SMTP is always mocked, no mail is sent."""
import copy
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from backend.notifications import NotificationDispatcher, PreviewMail, SmtpMail, configured_transport, message
from test_documents import Database, Reference, transactional


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(); self.id = 'app__Approved'; self.reference = 'NAMPOL-2026-TEST01'
        self.db.data[('applications', 'app')] = {'status': 'Approved', 'applicantId': 'alice',
            'applicationReference': self.reference, 'region': 'Khomas', 'reviewedBy': 'admin',
            'reviewedAt': 'server-time', 'documentSetId': 'a' * 32, 'decisionReason': 'PRIVATE REASON', 'applicantEmail': 'attacker@example.invalid'}
        self.db.data[('auditLogs', 'app__APPLICATION_APPROVED')] = {'action': 'APPLICATION_APPROVED', 'applicationId': 'app', 'adminId': 'admin'}
        self.db.data[('serverApplicationDocumentBindings', 'app')] = {'ownerUid': 'alice', 'setId': 'a' * 32}
        self.db.data[('notificationOutbox', self.id)] = {'applicationId': 'app', 'applicantId': 'alice',
            'applicationReference': self.reference, 'region': 'Khomas', 'status': 'Approved', 'state': 'pending', 'createdAt': 'server-time'}
        self.lookup = Mock(return_value=SimpleNamespace(email='verified@example.invalid', email_verified=True, disabled=False))
        self.mail = Mock(outcome='sent')
        self.service = NotificationDispatcher(self.db, self.lookup, self.mail)
        p = patch('backend.notifications.firestore.transactional', transactional); p.start(); self.addCleanup(p.stop)

    def state(self): return self.db.read('notificationOutbox', self.id)['state']
    def actions(self): return [value.get('action') for (collection, _), value in self.db.data.items() if collection == 'auditLogs']

    def test_send_uses_verified_auth_email_not_applicant_supplied_recipient_and_excludes_sensitive_fields(self):
        self.assertEqual(self.service.deliver(self.id), 'sent')
        recipient, subject, body, key = self.mail.send.call_args.args
        self.assertEqual(recipient, 'verified@example.invalid'); self.assertEqual(key, self.id)
        self.assertIn(self.reference, subject); self.assertIn('Approved', body)
        self.assertNotIn('PRIVATE', body); self.assertNotIn('attacker', body)
        self.assertEqual(self.state(), 'sent')
        self.assertEqual(self.service.deliver(self.id), 'unchanged'); self.mail.send.assert_called_once()
        self.assertIn('NOTIFICATION_SENT', self.actions())

    def test_preview_is_not_sent_and_never_invokes_smtp(self):
        self.service.transport = PreviewMail()
        with patch('backend.notifications.smtplib.SMTP') as smtp, patch('backend.notifications.smtplib.SMTP_SSL') as ssl:
            self.assertEqual(self.service.deliver(self.id), 'previewed')
            smtp.assert_not_called(); ssl.assert_not_called()
        self.assertIn('NOTIFICATION_PREVIEWED', self.actions())

    def test_parallel_dispatchers_claim_once(self):
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(self.service.deliver, [self.id, self.id]))
        self.assertCountEqual(outcomes, ['sent', 'unchanged']); self.mail.send.assert_called_once()

    def test_uncertain_smtp_acceptance_is_not_automatically_retried(self):
        self.mail.send.side_effect = TimeoutError('may already have accepted')
        self.assertEqual(self.service.deliver(self.id), 'delivery_unknown')
        self.assertEqual(self.service.deliver(self.id), 'unchanged'); self.mail.send.assert_called_once()

    def test_crash_after_send_before_persisting_success_leaves_processing_without_resend(self):
        with patch.object(self.service, 'finish', side_effect=RuntimeError('database unavailable')):
            with self.assertRaises(RuntimeError): self.service.deliver(self.id)
        self.assertEqual(self.state(), 'processing')
        self.assertEqual(self.service.deliver(self.id), 'unchanged'); self.mail.send.assert_called_once()

    def test_audit_failure_rolls_back_claim_and_never_sends(self):
        create = Reference.create
        def failed(ref, value):
            if value.get('action') == 'NOTIFICATION_DELIVERY_STARTED': raise RuntimeError('audit unavailable')
            return create(ref, value)
        with patch.object(Reference, 'create', failed):
            with self.assertRaises(RuntimeError): self.service.deliver(self.id)
        self.assertEqual(self.state(), 'pending'); self.mail.send.assert_not_called()

    def test_deleted_changed_or_unbound_applications_cannot_trigger_notification(self):
        for source in [('applications', 'app'), ('auditLogs', 'app__APPLICATION_APPROVED'), ('serverApplicationDocumentBindings', 'app')]:
            previous = self.db.data.pop(source)
            with self.assertRaises(ValueError): self.service.deliver(self.id)
            self.db.data[source] = previous
        self.db.data[('applications', 'app')]['status'] = 'Denied'
        with self.assertRaises(ValueError): self.service.deliver(self.id)
        self.mail.send.assert_not_called()

    def test_unverified_disabled_or_missing_auth_recipient_is_blocked(self):
        for user in [SimpleNamespace(email_verified=False, disabled=False, email='test@example.invalid'),
                     SimpleNamespace(email_verified=True, disabled=True, email='test@example.invalid'),
                     SimpleNamespace(email_verified=True, disabled=False, email='bad\r\nBcc:other@example.invalid')]:
            self.db.data[('notificationOutbox', self.id)]['state'] = 'pending'
            # Each subcase uses independent audit events rather than replaying a claim.
            self.db.data.pop(('auditLogs', self.id + '__started'), None)
            self.db.data.pop(('auditLogs', self.id + '__blocked'), None)
            self.lookup.return_value = user
            self.assertEqual(self.service.deliver(self.id), 'blocked')
        self.mail.send.assert_not_called()

    def test_message_validation_and_denial_content(self):
        subject, body = message(self.reference, 'Denied')
        self.assertIn(self.reference, subject); self.assertIn('Denied', body)
        for reference, status in [('bad\nSubject:injected', 'Approved'), (self.reference, 'Rejected'), ('REAL NAME', 'Approved')]:
            with self.assertRaises(ValueError): message(reference, status)

    def test_live_delivery_requires_explicit_configuration_and_approval(self):
        with patch.dict('os.environ', {}, clear=True): self.assertIsInstance(configured_transport(), PreviewMail)
        with patch.dict('os.environ', {'NAMPOL_EMAIL_MODE': 'smtp'}, clear=True):
            with self.assertRaises(ValueError): configured_transport()
        with patch.dict('os.environ', {'NAMPOL_EMAIL_MODE': 'disabled'}, clear=True): self.assertIsNone(configured_transport())

    def test_smtp_requires_tls_and_only_sends_plain_status_email_with_stable_message_id(self):
        values = {'NAMPOL_SMTP_HOST': 'smtp.example.invalid', 'NAMPOL_SMTP_FROM': 'nampol@example.invalid',
            'NAMPOL_SMTP_USERNAME': 'synthetic-user', 'NAMPOL_SMTP_PASSWORD': 'synthetic-password', 'NAMPOL_SMTP_PORT': '587'}
        with patch.dict('os.environ', values, clear=True), patch('backend.notifications.smtplib.SMTP') as smtp:
            transport = SmtpMail(); subject, body = message(self.reference, 'Approved')
            transport.send('test@example.invalid', subject, body, self.id)
            client = smtp.return_value.__enter__.return_value
            client.starttls.assert_called_once(); client.login.assert_called_once()
            email = client.send_message.call_args.args[0]
            self.assertEqual(email['Message-ID'], '<nampol-app__Approved@example.invalid>')
            self.assertFalse(email.is_multipart()); self.assertNotIn('PRIVATE', email.get_content())
        values['NAMPOL_SMTP_PORT'] = '25'
        with patch.dict('os.environ', values, clear=True):
            with self.assertRaises(ValueError): SmtpMail()

    def test_explicit_pre_send_retry_preserves_audits_and_cannot_reset_sent_or_unknown_jobs(self):
        self.lookup.return_value.email_verified = False
        self.assertEqual(self.service.deliver(self.id), 'blocked'); self.mail.send.assert_not_called()
        prior_audits = copy.deepcopy({key: value for key, value in self.db.data.items() if key[0] == 'auditLogs'})
        self.service.retry_blocked(self.id)
        self.lookup.return_value.email_verified = True
        self.assertEqual(self.service.deliver(self.id), 'sent'); self.mail.send.assert_called_once()
        for key, value in prior_audits.items(): self.assertEqual(self.db.data[key], value)
        self.assertIn('NOTIFICATION_RETRY_SCHEDULED', self.actions())
        for state in ('sent', 'previewed', 'processing', 'delivery_unknown'):
            self.db.data[('notificationOutbox', self.id)]['state'] = state
            with self.assertRaises(ValueError): self.service.retry_blocked(self.id)


if __name__ == '__main__': unittest.main()
