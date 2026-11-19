"""Offline tests for consent-gated, evidence-only OpenAI CV review."""
import json
import unittest
from unittest.mock import patch

import httpx
from fastapi import HTTPException

from backend.ai_screening import OpenAICVReviewer, redact_cv_text


class FakeResponse:
    def __init__(self, body=None, error=None):
        self.body = body
        self.error = error

    def raise_for_status(self):
        if self.error:
            raise self.error

    def json(self):
        return self.body


def response_for(requirement, quote):
    return FakeResponse({
        "output_text": json.dumps({
            "criteria": [{"requirement": requirement, "evidence_quotes": [quote]}],
        }),
    })


class RedactionTests(unittest.TestCase):
    def test_removes_labeled_identity_lines_and_masks_email_and_phone(self):
        redacted = redact_cv_text(
            "Name: Synthetic Applicant\nEmail: person@example.invalid\n"
            "Phone: +264 81 123 4567\nSkills: Python and first aid"
        )
        self.assertNotIn("Synthetic Applicant", redacted)
        self.assertNotIn("person@example.invalid", redacted)
        self.assertNotIn("+264 81 123 4567", redacted)
        self.assertIn("Skills: Python and first aid", redacted)
        self.assertNotIn("12345", redact_cv_text("ID: 12345\nAge: 24\nNationality: Namibian"))


class ProviderTests(unittest.TestCase):
    def test_sends_only_redacted_cv_and_requirements_with_non_stored_structured_request(self):
        calls = []

        def post(url, **kwargs):
            calls.append((url, kwargs))
            return response_for("CV: Python", "Skills: Python and first aid")

        reviewer = OpenAICVReviewer("synthetic-api-key", post=post)
        result = reviewer.review(
            ["CV: Python"],
            "Name: Synthetic Applicant\nEmail: person@example.invalid\n"
            "Phone: +264 81 123 4567\nSkills: Python and first aid",
        )

        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["criteria"][0]["evidenceQuotes"], ["Skills: Python and first aid"])
        self.assertEqual(len(calls), 1)
        url, request = calls[0]
        self.assertEqual(url, "https://api.openai.com/v1/responses")
        self.assertEqual(request["json"]["store"], False)
        self.assertEqual(request["timeout"], 45.0)
        self.assertEqual(request["follow_redirects"], False)
        self.assertEqual(request["trust_env"], False)
        self.assertEqual(request["headers"]["Authorization"], "Bearer synthetic-api-key")
        body = request["json"]["input"][1]["content"]
        self.assertIn("Skills: Python and first aid", body)
        self.assertNotIn("Synthetic Applicant", body)
        self.assertNotIn("person@example.invalid", body)
        self.assertNotIn("+264 81 123 4567", body)

    def test_rejects_quotes_not_found_in_redacted_cv(self):
        reviewer = OpenAICVReviewer(
            "synthetic-api-key",
            post=lambda *_args, **_kwargs: response_for("CV: Python", "Python certified"),
        )
        with self.assertRaises(HTTPException) as error:
            reviewer.review(["CV: Python"], "Skills: Python")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("unverifiable", error.exception.detail)

    def test_malformed_provider_shape_is_an_explicit_error(self):
        reviewer = OpenAICVReviewer("synthetic-api-key",
            post=lambda *_args, **_kwargs: FakeResponse({"output": [{"type": "message", "content": None}]}))
        with self.assertRaises(HTTPException) as error:
            reviewer.review(["CV: Python"], "Skills: Python")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("unusable", error.exception.detail)

    def test_provider_timeout_is_an_explicit_unavailable_error(self):
        def timeout(*_args, **_kwargs):
            raise httpx.ReadTimeout("synthetic timeout")

        reviewer = OpenAICVReviewer("synthetic-api-key", post=timeout)
        with self.assertRaises(HTTPException) as error:
            reviewer.review(["CV: Python"], "Skills: Python")
        self.assertEqual(error.exception.status_code, 503)
        self.assertIn("unavailable", error.exception.detail)

    def test_missing_api_key_is_explicit_and_makes_no_request(self):
        calls = []
        reviewer = OpenAICVReviewer("", post=lambda *args, **kwargs: calls.append((args, kwargs)))
        with self.assertRaises(HTTPException) as error:
            reviewer.review(["CV: Python"], "Skills: Python")
        self.assertEqual(error.exception.status_code, 503)
        self.assertEqual(calls, [])

    def test_feature_is_off_by_default_and_requires_valid_explicit_configuration(self):
        with patch.dict("os.environ", {}, clear=True):
            self.assertIsNone(OpenAICVReviewer.from_environment())
        with patch.dict("os.environ", {"NAMPOL_CV_AI_ENABLED": "maybe"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be true or false"):
                OpenAICVReviewer.from_environment()
        with patch.dict("os.environ", {
            "NAMPOL_CV_AI_ENABLED": "true",
            "OPENAI_API_KEY": "synthetic-api-key",
        }, clear=True):
            reviewer = OpenAICVReviewer.from_environment()
            self.assertIsInstance(reviewer, OpenAICVReviewer)
            self.assertEqual(reviewer.api_key, "synthetic-api-key")


if __name__ == "__main__":
    unittest.main()
