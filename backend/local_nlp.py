"""Local evidence matching for applicant CV text; never evaluates eligibility."""
import logging
import math
import re

from backend.ai_screening import redact_cv_text

logger = logging.getLogger("nampol.screening")
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
SIMILARITY_THRESHOLD = 0.48
MAX_EXCERPT_LENGTH = 280
STOP_WORDS = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
    "has", "in", "is", "of", "on", "or", "the", "to", "with",
})
QUALIFICATION_TERM = re.compile(
    r"\b(?:certificate|diploma|bachelor(?:s)?|b[as]c|btech|honou?rs|"
    r"master(?:s)?|m[as]c|phd|doctorate)\b",
    re.IGNORECASE,
)


def _tokens(value):
    return [word for word in re.findall(r"[a-z0-9]+", value.lower())
            if word not in STOP_WORDS and len(word) > 1]


def _chunks(text):
    output = []
    for line in text.splitlines():
        for sentence in re.split(r"(?<=[.!?])\s+", line.strip()):
            snippet = " ".join(sentence.split())
            if not snippet:
                continue
            safe = redact_cv_text(snippet)
            if safe:
                output.append(safe[:MAX_EXCERPT_LENGTH])
            if len(output) >= 500:
                return output
    return output


class LocalEvidenceMatcher:
    def __init__(self, model_loader=None):
        self._model_loader = model_loader or self._load_model
        self._model = None
        self._model_checked = False

    @staticmethod
    def _load_model():
        from fastembed import TextEmbedding
        return TextEmbedding(model_name=MODEL_NAME)

    @property
    def engine(self):
        if self._model is not None:
            return "Local sentence embeddings (FastEmbed, CPU)"
        if self._model_checked:
            return "Local NLP text-match fallback (token overlap)"
        return "Local exact-phrase matching (embedding model not needed)"

    def prepare(self):
        self._ensure_model()
        return self.engine

    def _ensure_model(self):
        if self._model_checked:
            return
        self._model_checked = True
        try:
            self._model = self._model_loader()
        except Exception as error:
            logger.warning("Local CV embedding model unavailable; using local lexical matching: reason=%s",
                           type(error).__name__)

    @staticmethod
    def _cosine(left, right):
        dot = sum(a * b for a, b in zip(left, right))
        left_norm = math.sqrt(sum(value * value for value in left))
        right_norm = math.sqrt(sum(value * value for value in right))
        return dot / (left_norm * right_norm) if left_norm and right_norm else 0.0

    def find(self, requirement, text):
        candidates = _chunks(text)
        if not candidates:
            return None
        query = " ".join(_tokens(requirement))
        if not query:
            return None
        normalized_query = " ".join(query.split())
        for candidate in candidates:
            candidate_tokens = " ".join(_tokens(candidate))
            if f" {normalized_query} " in f" {candidate_tokens} ":
                return {"excerpt": candidate, "method": "exact phrase"}

        # Similar credentials are not interchangeable; only surface the
        # credential level when the CV contains the same explicit term.
        if QUALIFICATION_TERM.search(requirement):
            return None

        self._ensure_model()
        if self._model is not None:
            try:
                vectors = list(self._model.embed([requirement, *candidates]))
                if len(vectors) == len(candidates) + 1:
                    scored = [(self._cosine(vectors[0], vector), candidate)
                              for vector, candidate in zip(vectors[1:], candidates)]
                    score, excerpt = max(scored, key=lambda row: row[0])
                    if score >= SIMILARITY_THRESHOLD:
                        return {"excerpt": excerpt, "method": "local sentence similarity"}
            except Exception as error:
                logger.warning("Local CV embedding failed; using local lexical matching: reason=%s",
                               type(error).__name__)
                self._model = None

        query_tokens = set(_tokens(requirement))
        if len(query_tokens) < 2:
            return None
        scored = []
        for candidate in candidates:
            candidate_tokens = set(_tokens(candidate))
            overlap = len(query_tokens & candidate_tokens) / len(query_tokens)
            if overlap >= 0.67:
                scored.append((overlap, candidate))
        return ({"excerpt": max(scored, key=lambda row: row[0])[1],
                 "method": "local token overlap"} if scored else None)
