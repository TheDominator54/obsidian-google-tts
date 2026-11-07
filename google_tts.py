#!/usr/bin/env python3
"""Dependency-light client for Google Cloud TTS and Gemini speech generation."""

from __future__ import annotations

import argparse
import base64
from email.utils import parsedate_to_datetime
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import wave


API_ROOT = "https://texttospeech.googleapis.com/v1"
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash-tts"  # Explicit Gemini API / Personal Voice route.
DEFAULT_SYNTHESIS_MODEL = "gemini-3.1-flash-tts-preview"
PERSONAL_VOICE = "Personal Voice"
PERSONAL_VOICE_TEMPERATURE = 1.4
SCOPE = "https://www.googleapis.com/auth/cloud-platform"
SKILL_ADC = Path.home() / ".config" / "google-tts-skill" / "application_default_credentials.json"
GCLOUD_ADC = Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
ENCODING_EXTENSIONS = {"MP3": ".mp3", "LINEAR16": ".wav", "OGG_OPUS": ".ogg"}
DEFAULT_SYNTHESIS_BY_LANGUAGE = {
    "en-US": {
        "voice": "Charon",
        "model": DEFAULT_SYNTHESIS_MODEL,
    },
}
STANDARD_INPUT_BYTE_LIMIT = 5000
GEMINI_FIELD_BYTE_LIMIT = 4000
GEMINI_TOTAL_INPUT_BYTE_LIMIT = 8000
STANDARD_REQUEST_TIMEOUT_SECONDS = 60
GEMINI_REQUEST_TIMEOUT_SECONDS = 240
GEMINI_STYLE_BYTE_LIMIT = 120


class TtsError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        http_status: int | None = None,
        google_status: str | None = None,
        transient: bool | None = None,
        retry_after: str | None = None,
        retry_after_seconds: float | None = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.google_status = google_status
        self.transient = transient
        self.retry_after = retry_after
        self.retry_after_seconds = retry_after_seconds


def _read_utf8(path: str | Path) -> str:
    """Decode UTF-8 without universal-newline translation."""
    return Path(path).read_bytes().decode("utf-8")


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value)
            return max(0.0, retry_at.timestamp() - time.time())
        except (TypeError, ValueError, OverflowError):
            return None


def _google_retry_delay(error: dict) -> float | None:
    """Read a nonnegative protobuf Duration from Google RPC RetryInfo."""
    details = error.get("details", [])
    if not isinstance(details, list):
        return None
    for detail in details:
        if not isinstance(detail, dict) or detail.get("@type") != "type.googleapis.com/google.rpc.RetryInfo":
            continue
        duration = detail.get("retryDelay")
        if not isinstance(duration, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,9})?s", duration):
            continue
        seconds = float(duration[:-1])
        if math.isfinite(seconds):
            return seconds
    return None


def _validate_audio_signature(audio: bytes, encoding: str) -> None:
    valid = False
    if encoding == "MP3":
        valid = audio.startswith(b"ID3") or (
            len(audio) >= 2 and audio[0] == 0xFF and audio[1] & 0xE0 == 0xE0
        )
    elif encoding == "LINEAR16":
        valid = len(audio) >= 12 and audio.startswith(b"RIFF") and audio[8:12] == b"WAVE"
    elif encoding == "OGG_OPUS":
        valid = audio.startswith(b"OggS")
    if not valid:
        raise TtsError(f"Google TTS returned audio that does not match {encoding}")


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temporary_path = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _json_request(url: str, *, method: str = "GET", data: dict | None = None,
                  token: str | None = None, quota_project: str | None = None,
                  api_key: str | None = None,
                  timeout: int = STANDARD_REQUEST_TIMEOUT_SECONDS) -> dict | list:
    body = None if data is None else json.dumps(data).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if quota_project:
        headers["x-goog-user-project"] = quota_project
    if api_key:
        headers["x-goog-api-key"] = api_key
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        finally:
            exc.close()
        google_status = None
        structured_retry_after = None
        insufficient_scope = "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in detail
        try:
            parsed = json.loads(detail)
            # streamGenerateContent can wrap HTTP errors in a JSON event array.
            # Preserve HTTP classification even for unfamiliar JSON shapes.
            events = parsed if isinstance(parsed, list) else [parsed]
            error = next(
                (event["error"] for event in events
                 if isinstance(event, dict) and isinstance(event.get("error"), dict)),
                None,
            )
            if error is not None:
                if error.get("message") is not None:
                    detail = str(error["message"])
                status = error.get("status")
                google_status = status if isinstance(status, str) else None
                structured_retry_after = _google_retry_delay(error)
        except json.JSONDecodeError:
            pass
        for secret in (api_key, token):
            if secret:
                detail = detail.replace(secret, "[redacted]")
        if (token and url.startswith(GEMINI_API_ROOT + "/") and exc.code == 403
                and (insufficient_scope or "insufficient authentication scopes" in detail.lower())):
            detail += (" Reconnect the saved Google OAuth login with scripts/oauth_login.py --gemini "
                       "and the existing Desktop OAuth client to grant Gemini API access.")
        transient = exc.code == 429 or 500 <= exc.code <= 599
        retry_after = exc.headers.get("Retry-After") if exc.headers else None
        retry_after_seconds = (
            _parse_retry_after(retry_after) if retry_after is not None else structured_retry_after
        )
        status_label = f" ({google_status})" if google_status else ""
        raise TtsError(
            f"Google API HTTP {exc.code}{status_label}: {detail}",
            http_status=exc.code,
            google_status=google_status,
            transient=transient,
            retry_after=retry_after,
            retry_after_seconds=retry_after_seconds,
        ) from exc
    except urllib.error.URLError as exc:
        raise TtsError(f"Could not reach Google TTS: {exc.reason}", transient=True) from exc
    except TimeoutError as exc:
        raise TtsError(
            f"Google TTS did not respond within {timeout} seconds",
            transient=True,
        ) from exc


def _form_post(url: str, values: dict[str, str]) -> dict:
    body = urllib.parse.urlencode(values).encode("ascii")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            detail = exc.read().decode("utf-8", errors="replace")
        finally:
            exc.close()
        raise TtsError(f"OAuth token request failed with HTTP {exc.code}: {detail}") from exc


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _refresh_authorized_user(credential: dict) -> str:
    result = _form_post(
        credential.get("token_uri", "https://oauth2.googleapis.com/token"),
        {
            "client_id": credential["client_id"],
            "client_secret": credential["client_secret"],
            "refresh_token": credential["refresh_token"],
            "grant_type": "refresh_token",
        },
    )
    try:
        return result["access_token"]
    except KeyError as exc:
        raise TtsError("OAuth refresh response did not contain an access token") from exc


def _service_account_token(credential: dict) -> str:
    openssl = shutil.which("openssl")
    if not openssl:
        raise TtsError("A service-account credential requires the openssl command")
    now = int(time.time())
    token_uri = credential.get("token_uri", "https://oauth2.googleapis.com/token")
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = _b64url(json.dumps({
        "iss": credential["client_email"],
        "scope": SCOPE,
        "aud": token_uri,
        "iat": now,
        "exp": now + 3600,
    }, separators=(",", ":")).encode())
    unsigned = f"{header}.{claims}".encode("ascii")
    key_path = None
    try:
        with tempfile.NamedTemporaryFile("w", prefix="google-tts-key-", suffix=".pem", delete=False) as key_file:
            key_path = key_file.name
            os.chmod(key_path, 0o600)
            key_file.write(credential["private_key"])
        signed = subprocess.run(
            [openssl, "dgst", "-sha256", "-sign", key_path],
            input=unsigned,
            capture_output=True,
            check=True,
        ).stdout
    except (KeyError, subprocess.CalledProcessError) as exc:
        raise TtsError("Could not sign a service-account assertion") from exc
    finally:
        if key_path:
            Path(key_path).unlink(missing_ok=True)
    assertion = f"{header}.{claims}.{_b64url(signed)}"
    result = _form_post(token_uri, {
        "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
        "assertion": assertion,
    })
    try:
        return result["access_token"]
    except KeyError as exc:
        raise TtsError("Service-account token response did not contain an access token") from exc


def _load_credential(path: Path) -> tuple[str, str | None, str]:
    try:
        credential = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise TtsError(f"Could not read credential file: {path}") from exc
    credential_type = credential.get("type")
    if credential_type == "authorized_user":
        token = _refresh_authorized_user(credential)
    elif credential_type == "service_account":
        token = _service_account_token(credential)
    else:
        raise TtsError(
            f"Unsupported credential type in {path}. Expected authorized_user or service_account, "
            "not an OAuth client-secret download."
        )
    return token, credential.get("quota_project_id"), str(path)


def credentials() -> tuple[str, str | None, str]:
    configured = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
    candidates = [Path(configured).expanduser()] if configured else []
    candidates.extend([SKILL_ADC, GCLOUD_ADC])
    for path in candidates:
        if path.is_file():
            return _load_credential(path)
    gcloud = shutil.which("gcloud")
    if gcloud:
        try:
            result = subprocess.run(
                [gcloud, "auth", "application-default", "print-access-token"],
                check=True,
                capture_output=True,
                text=True,
            )
            token = result.stdout.strip()
            if token:
                return token, None, "gcloud Application Default Credentials"
        except subprocess.CalledProcessError as exc:
            message = exc.stderr.strip() or "gcloud could not obtain an ADC token"
            raise TtsError(message) from exc
    raise TtsError(
        "No Application Default Credentials found. Run scripts/oauth_login.py with a Desktop app "
        "OAuth client, run 'gcloud auth application-default login', or set "
        "GOOGLE_APPLICATION_CREDENTIALS to a service-account key."
    )


def command_voices(args: argparse.Namespace) -> None:
    token, quota_project, _ = credentials()
    query = ""
    if args.language_code:
        query = "?" + urllib.parse.urlencode({"languageCode": args.language_code})
    response = _json_request(f"{API_ROOT}/voices{query}", token=token, quota_project=quota_project)
    voices = response.get("voices", [])
    if args.json:
        print(json.dumps(voices, indent=2, ensure_ascii=False))
        return
    if not voices:
        print("No voices found.")
        return
    print("NAME\tLANGUAGES\tGENDER\tSAMPLE_RATE_HZ")
    for voice in sorted(voices, key=lambda item: item.get("name", "")):
        print("\t".join([
            voice.get("name", ""),
            ",".join(voice.get("languageCodes", [])),
            voice.get("ssmlGender", ""),
            str(voice.get("naturalSampleRateHertz", "")),
        ]))


def _read_input(args: argparse.Namespace) -> tuple[str | list[dict[str, str]], str]:
    sources = [
        args.text is not None,
        args.input_file is not None,
        args.ssml is not None,
        args.ssml_file is not None,
        args.multi_speaker_file is not None,
        getattr(args, "turns_file", None) is not None,
    ]
    if sum(sources) != 1:
        raise TtsError(
            "Provide exactly one of --text, --input-file, --ssml, --ssml-file, "
            "--multi-speaker-file, or --turns-file"
        )
    if args.text is not None:
        return args.text, "text"
    if args.input_file is not None:
        return _read_utf8(args.input_file), "text"
    if args.ssml is not None:
        return args.ssml, "ssml"
    if args.ssml_file is not None:
        return _read_utf8(args.ssml_file), "ssml"
    if getattr(args, "turns_file", None) is not None:
        try:
            parsed = json.loads(_read_utf8(args.turns_file))
        except json.JSONDecodeError as exc:
            raise TtsError(f"Structured turns input is not valid JSON: {exc}") from exc
        return _validate_turn_document(parsed), "turns"
    try:
        parsed = json.loads(_read_utf8(args.multi_speaker_file))
    except json.JSONDecodeError as exc:
        raise TtsError(f"Multi-speaker input is not valid JSON: {exc}") from exc
    turns = parsed.get("turns") if isinstance(parsed, dict) else parsed
    if not isinstance(turns, list) or not turns:
        raise TtsError("Multi-speaker input must contain a non-empty turns list")
    normalized = []
    for index, turn in enumerate(turns, start=1):
        if not isinstance(turn, dict):
            raise TtsError(f"Multi-speaker turn {index} must be an object")
        speaker = turn.get("speaker")
        text = turn.get("text")
        if not isinstance(speaker, str) or not speaker.strip():
            raise TtsError(f"Multi-speaker turn {index} needs a speaker")
        if not isinstance(text, str) or not text.strip():
            raise TtsError(f"Multi-speaker turn {index} needs text")
        normalized.append({"speaker": speaker.strip(), "text": text})
    return normalized, "multi"


def _read_prompt(args: argparse.Namespace) -> str | None:
    sources = [args.prompt is not None, args.prompt_file is not None]
    if sum(sources) > 1:
        raise TtsError("Provide at most one of --prompt or --prompt-file")
    if args.prompt is not None:
        return args.prompt
    if args.prompt_file is not None:
        return _read_utf8(args.prompt_file)
    return None


def _resolve_voice_settings(
    language_code: str,
    requested_voice: str | None,
    requested_model: str | None,
) -> tuple[str | None, str | None]:
    if requested_voice == PERSONAL_VOICE:
        return PERSONAL_VOICE, requested_model or DEFAULT_GEMINI_MODEL
    default = DEFAULT_SYNTHESIS_BY_LANGUAGE.get(language_code, {})
    if requested_voice is None and requested_model is None:
        return default.get("voice"), default.get("model")
    if requested_voice is None:
        return default.get("voice"), requested_model
    return requested_voice, requested_model or (default.get("model") if requested_voice == default.get("voice") else None)


def _is_gemini_model(model_name: str | None) -> bool:
    return bool(model_name and model_name.startswith("gemini-"))


def _parse_speaker_voices(values: list[str]) -> dict[str, str]:
    result = {}
    for value in values:
        alias, separator, voice = value.partition("=")
        alias = alias.strip()
        voice = voice.strip()
        if not separator or not alias or not voice:
            raise TtsError("--speaker-voice must use ALIAS=VOICE, such as Derek=Charon")
        if alias in result:
            raise TtsError(f"Duplicate multi-speaker alias: {alias}")
        result[alias] = voice
    return result


def _validate_turn_document(document: object) -> list[dict[str, str]]:
    """Accept only source turns and optional short delivery metadata, never raw API JSON."""
    if not isinstance(document, dict) or set(document) != {"turns"}:
        raise TtsError('--turns-file must contain exactly {"turns": [...]}')
    turns = document["turns"]
    if not isinstance(turns, list) or not turns:
        raise TtsError("Structured turns input needs a nonempty turns list")
    result = []
    for index, turn in enumerate(turns, start=1):
        if not isinstance(turn, dict) or not {"speaker", "text"} <= set(turn) <= {"speaker", "text", "style"}:
            raise TtsError(f"Turn {index} must contain speaker, text, and optionally style only")
        speaker, text = turn["speaker"], turn["text"]
        if not isinstance(speaker, str) or not speaker.strip() or speaker != speaker.strip():
            raise TtsError(f"Turn {index} needs a nonempty speaker alias without surrounding whitespace")
        if not isinstance(text, str) or not text.strip():
            raise TtsError(f"Turn {index} needs nonempty source text")
        if "style" in turn:
            style = turn["style"]
            if (not isinstance(style, str) or not style.strip()
                    or len(style.encode("utf-8")) > GEMINI_STYLE_BYTE_LIMIT
                    or any(char in style for char in "\r\n\t[]<>")):
                raise TtsError(f"Turn {index} style must be a short plain phrase of at most {GEMINI_STYLE_BYTE_LIMIT} UTF-8 bytes")
        # Do not trim source text, add speaker labels, or embed delivery cues in it.
        result.append(dict(turn))
    return result


def prepare_gemini_turns(document: object, speaker_voices: dict[str, str]) -> dict:
    """Offline preflight for Gemini 3.8 structured turns, shared by CLI and workflows.

    Returns API parts/speech configuration plus exact joined text and a hash-bound
    turn manifest. A one-speaker repair omits speaker metadata, matching the
    approved isolated-voice request. This function never rewrites source text.
    """
    turns = _validate_turn_document(document)
    if not isinstance(speaker_voices, dict) or len(speaker_voices) not in {1, 2}:
        raise TtsError("Structured turns require one or two --speaker-voice mappings")
    for alias, voice in speaker_voices.items():
        if not isinstance(alias, str) or not alias.strip() or alias != alias.strip():
            raise TtsError("Speaker mappings need nonempty aliases without surrounding whitespace")
        if (not isinstance(voice, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9]*", voice)
                or voice == PERSONAL_VOICE):
            raise TtsError("Structured turns support named prebuilt voices only; Personal Voice and stored voice IDs remain plain-text only")
    if {turn["speaker"] for turn in turns} != set(speaker_voices):
        raise TtsError("Turn speaker aliases must exactly match the --speaker-voice aliases")
    text = "".join(turn["text"] for turn in turns)
    if len(text.encode("utf-8")) > GEMINI_FIELD_BYTE_LIMIT:
        raise TtsError(f"Use sections of at most {GEMINI_FIELD_BYTE_LIMIT:,} UTF-8 source bytes")
    multiple = len(speaker_voices) == 2
    parts, manifest = [], []
    for index, turn in enumerate(turns):
        metadata = {"speaker": turn["speaker"]} if multiple else {}
        if "style" in turn:
            metadata["style"] = turn["style"]
        part = {"text": turn["text"]}
        if metadata:
            part["speechMetadata"] = metadata
        parts.append(part)
        manifest.append({
            "index": index,
            **turn,
            "voice": speaker_voices[turn["speaker"]],
            "text_sha256": _sha256(turn["text"].encode("utf-8")),
            "speaker_sha256": _sha256(turn["speaker"].encode("utf-8")),
            "style_sha256": _sha256(turn["style"].encode("utf-8")) if "style" in turn else None,
        })
    if multiple:
        speech_config = {"multiSpeakerVoiceConfig": {"speakerVoiceConfigs": [
            {"speaker": alias, "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}
            for alias, voice in speaker_voices.items()
        ]}}
    else:
        speech_config = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": next(iter(speaker_voices.values()))}}}
    return {
        "turns": turns, "text": text, "parts": parts, "speech_config": speech_config,
        "turn_manifest": manifest,
        "turn_manifest_sha256": _sha256(_canonical_json_bytes(manifest)),
        "speaker_voices_sha256": _sha256(_canonical_json_bytes(speaker_voices)),
    }


def _quota_project_override(args: argparse.Namespace) -> str | None:
    requested = getattr(args, "quota_project", None)
    if requested is None:
        return None
    if not requested.strip():
        raise TtsError("--quota-project must be a nonempty Google project ID or number")
    return requested.strip()


def _gemini_auth(quota_project_override: str | None = None, *, api_key_file: str | None = None) -> tuple[dict[str, str | None], str]:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if api_key_file is not None:
        if quota_project_override is not None:
            raise TtsError("--api-key-file cannot be combined with --quota-project; an API key selects its own project")
        if key:
            raise TtsError("Choose --api-key-file or GEMINI_API_KEY, not both; unset GEMINI_API_KEY to use the file")
        path = Path(api_key_file).expanduser().resolve()
        try:
            if not path.is_file() or path.stat().st_mode & 0o077:
                raise TtsError("API-key file must be a regular file accessible only to its owner")
            key = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeError) as exc:
            raise TtsError(f"Could not read API-key file: {path}") from exc
        if not key or "\n" in key or "\r" in key:
            raise TtsError("API-key file must contain one nonempty key")
        # Treat keys as opaque credentials. Valid keys are not limited to AIza.
        return {"api_key": key}, str(path)
    if key:
        if quota_project_override is not None:
            raise TtsError(
                "--quota-project only overrides OAuth quota projects; GEMINI_API_KEY selects its own project. "
                "Unset GEMINI_API_KEY for this command to use the saved OAuth login."
            )
        return {"api_key": key}, "GEMINI_API_KEY"
    try:
        token, quota_project, source = credentials()
    except TtsError as exc:
        if "invalid_grant" in str(exc):
            raise TtsError(
                "The saved Google OAuth login was rejected (invalid_grant). "
                "Reconnect with scripts/oauth_login.py --gemini and the existing Desktop OAuth client."
            ) from exc
        if "No Application Default Credentials found" in str(exc):
            raise TtsError(
                "Gemini API speech requires GEMINI_API_KEY or Google OAuth Application Default "
                "Credentials. Reconnect the existing Google login with scripts/oauth_login.py --gemini."
            ) from exc
        raise
    return {"token": token, "quota_project": quota_project_override or quota_project}, source


def _decode_gemini_audio(response: dict | list) -> tuple[bytes, int]:
    """Collect audio from the stream's JSON array, accepting PCM or WAV."""
    events = response if isinstance(response, list) else [response]
    chunks: list[bytes] = []
    mime_type = None
    finish_reason = None
    for event in events:
        if not isinstance(event, dict):
            raise TtsError("Gemini returned an invalid stream event")
        if event.get("error"):
            error = event["error"]
            if not isinstance(error, dict):
                raise TtsError("Gemini returned an invalid stream error; no audio was saved")
            code = error.get("code")
            code = code if isinstance(code, int) else None
            status = error.get("status")
            detail = str(error.get("message", "No error message supplied"))
            key = os.environ.get("GEMINI_API_KEY", "").strip()
            if key:
                detail = detail.replace(key, "[redacted]")
            raise TtsError(
                f"Gemini stream error {code or ''} ({status or 'UNKNOWN'}): {detail}",
                http_status=code,
                google_status=status,
                transient=None if code is None else code == 429 or 500 <= code <= 599,
                retry_after_seconds=_google_retry_delay(error),
            )
        block_reason = event.get("promptFeedback", {}).get("blockReason")
        if block_reason:
            raise TtsError(f"Gemini blocked the request: {block_reason}; no audio was saved")
        candidates = event.get("candidates", [])
        if not isinstance(candidates, list) or len(candidates) > 1:
            raise TtsError("Expected exactly one Gemini audio candidate")
        for candidate in candidates:
            reason = candidate.get("finishReason")
            if reason:
                finish_reason = reason
                if reason != "STOP":
                    raise TtsError(f"Gemini audio did not complete: {reason}; no audio was saved")
            for part in candidate.get("content", {}).get("parts", []):
                inline = part.get("inlineData") or part.get("inline_data")
                if not inline:
                    continue
                current_mime = inline.get("mimeType", inline.get("mime_type", "")).lower()
                if mime_type is not None and current_mime != mime_type:
                    raise TtsError("Gemini changed audio format within the stream")
                mime_type = current_mime
                try:
                    chunks.append(base64.b64decode(inline["data"], validate=True))
                except (KeyError, TypeError, ValueError) as exc:
                    raise TtsError("Gemini returned invalid base64 audio") from exc
    audio = b"".join(chunks)
    if not audio or not mime_type:
        raise TtsError("Gemini returned no audio")
    if finish_reason != "STOP":
        raise TtsError("Gemini stream ended without a completed response; no audio was saved")
    media_type, *parameters = mime_type.split(";")
    if media_type.strip() in {"audio/wav", "audio/x-wav", "audio/wave"}:
        try:
            with wave.open(io.BytesIO(audio), "rb") as wav:
                if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                    raise TtsError("Expected mono 16-bit Gemini WAV audio")
                sample_rate = wav.getframerate()
                expected_bytes = wav.getnframes() * 2
                pcm = wav.readframes(wav.getnframes())
                if len(pcm) != expected_bytes:
                    raise TtsError("Gemini returned a truncated WAV")
        except (wave.Error, EOFError) as exc:
            raise TtsError("Gemini returned an invalid WAV") from exc
    elif media_type.strip() in {"audio/l16", "audio/pcm"}:
        properties = dict(
            (key.strip(), value.strip())
            for parameter in parameters
            for key, separator, value in [parameter.partition("=")]
            if separator
        )
        if properties.get("codec", "pcm") != "pcm" or properties.get("channels", "1") != "1":
            raise TtsError("Expected mono PCM Gemini audio")
        try:
            sample_rate = int(properties.get("rate", "24000"))
        except ValueError as exc:
            raise TtsError("Gemini returned an invalid PCM sample rate") from exc
        pcm = audio
    else:
        raise TtsError(f"Unsupported Gemini audio MIME type: {mime_type}")
    if not pcm or len(pcm) % 2 or sample_rate <= 0:
        raise TtsError("Gemini returned empty or incomplete 16-bit PCM audio")
    return pcm, sample_rate


def _encode_gemini_audio(pcm: bytes, sample_rate: int, args: argparse.Namespace) -> bytes:
    wav_buffer = io.BytesIO()
    with wave.open(wav_buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm)
    if args.encoding == "LINEAR16" and args.sample_rate_hertz in {None, sample_rate}:
        return wav_buffer.getvalue()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TtsError("Install ffmpeg for Gemini MP3/OGG output or sample-rate conversion")
    with tempfile.TemporaryDirectory(prefix="google-tts-") as directory:
        source = Path(directory) / "source.wav"
        target = Path(directory) / ("output" + ENCODING_EXTENSIONS[args.encoding])
        source.write_bytes(wav_buffer.getvalue())
        command = [ffmpeg, "-v", "error", "-nostdin", "-i", str(source)]
        if args.sample_rate_hertz:
            command += ["-ar", str(args.sample_rate_hertz)]
        command += ["-c:a", {"LINEAR16": "pcm_s16le", "MP3": "libmp3lame", "OGG_OPUS": "libopus"}[args.encoding]]
        command += [str(target)]
        try:
            subprocess.run(command, check=True, capture_output=True, timeout=60)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise TtsError("ffmpeg could not convert Gemini audio; no output was replaced") from exc
        return target.read_bytes()


def _command_gemini_synthesize(
    args: argparse.Namespace,
    content: str | list[dict[str, str]],
    input_kind: str,
    voice_name: str | None,
    model_name: str | None,
) -> None:
    structured = input_kind == "turns"
    prepared = None
    speaker_voices = {}
    if structured:
        if model_name != DEFAULT_GEMINI_MODEL or args.voice is not None or getattr(args, "voice_id", None) is not None:
            raise TtsError("--turns-file requires Gemini 3.8 and --speaker-voice mappings, without --voice or --voice-id")
        speaker_voices = _parse_speaker_voices(args.speaker_voice)
        prepared = prepare_gemini_turns({"turns": content}, speaker_voices)
    elif input_kind != "text" or args.speaker_voice:
        raise TtsError("Gemini API synthesis requires plain text and one voice per call, or --turns-file with prebuilt speaker mappings")
    if _read_prompt(args) is not None:
        raise TtsError("Gemini API --prompt and --prompt-file are forbidden. Prebuilt voices may use short style metadata in --turns-file; Personal Voice remains plain-text only")
    if (not voice_name and not structured) or not _is_gemini_model(model_name):
        raise TtsError("Gemini API synthesis requires a named voice and a Gemini model")
    if any([args.speaking_rate is not None, args.pitch is not None,
            args.volume_gain_db is not None, args.effects_profile_id, args.gender]):
        raise TtsError("Gemini API synthesis uses a named voice without numeric voice controls or gender")
    if args.sample_rate_hertz is not None and args.sample_rate_hertz <= 0:
        raise TtsError("--sample-rate-hertz must be positive")
    # Keep requests bounded for section-based narration; this is a helper ceiling,
    # not a claim about the Gemini API's token-based context limit.
    source_text = prepared["text"] if prepared else content
    input_bytes = source_text.encode("utf-8")
    if not source_text.strip() or len(input_bytes) > GEMINI_FIELD_BYTE_LIMIT:
        raise TtsError(f"Use nonempty sections of at most {GEMINI_FIELD_BYTE_LIMIT:,} UTF-8 bytes")
    output = Path(args.output).expanduser()
    extension = ENCODING_EXTENSIONS[args.encoding]
    if output.suffix.lower() != extension:
        raise TtsError(f"{args.encoding} output should use the {extension} extension")
    if output.exists() and not args.force:
        raise TtsError(f"Output already exists: {output}. Use --force only when replacement is intended")
    if (args.encoding != "LINEAR16" or args.sample_rate_hertz not in {None, 24000}) and not shutil.which("ffmpeg"):
        raise TtsError("Install ffmpeg for Gemini MP3/OGG output or sample-rate conversion")
    voice_id = getattr(args, "voice_id", None)
    if voice_id is not None:
        voice_id = voice_id.strip()
        if args.voice != PERSONAL_VOICE or not voice_id:
            raise TtsError('--voice-id requires --voice "Personal Voice" and a nonempty stored voice ID')
    auth, credential_source = _gemini_auth(
        _quota_project_override(args), api_key_file=getattr(args, "api_key_file", None),
    )
    voice_config = {"voice": voice_id} if voice_id else {"prebuiltVoiceConfig": {"voiceName": voice_name}}
    generation_config = {
        "responseModalities": ["AUDIO"],
        "speechConfig": prepared["speech_config"] if prepared else {"voiceConfig": voice_config},
    }
    if voice_name == PERSONAL_VOICE and not structured:
        generation_config["temperature"] = PERSONAL_VOICE_TEMPERATURE
    payload = {
        "contents": [{"role": "user", "parts": prepared["parts"] if prepared else [{"text": content}]}],
        "generationConfig": generation_config,
    }
    endpoint = f"{GEMINI_API_ROOT}/models/{urllib.parse.quote(model_name, safe='')}:streamGenerateContent"
    response = _json_request(endpoint, method="POST", data=payload, **auth,
                             timeout=GEMINI_REQUEST_TIMEOUT_SECONDS)
    try:
        pcm, source_rate = _decode_gemini_audio(response)
    except TtsError as exc:
        # A streamed error can arrive in HTTP 200, outside _json_request's
        # redaction path. Cover explicitly loaded keys and OAuth tokens too.
        message = str(exc)
        for credential_name in ("api_key", "token"):
            secret = auth.get(credential_name)
            if secret:
                message = message.replace(secret, "[redacted]")
        exc.args = (message,)
        raise
    audio = _encode_gemini_audio(pcm, source_rate, args)
    _validate_audio_signature(audio, args.encoding)
    settings = {
        "api": "gemini",
        "method": "streamGenerateContent",
        "inputKind": input_kind,
        "voice": ({"speakers": speaker_voices, "modelName": model_name} if structured
                  else {"name": voice_name, "modelName": model_name}),
        "generationConfig": generation_config,
        "audioConfig": {"audioEncoding": args.encoding, "sampleRateHertz": args.sample_rate_hertz},
        "languageCode": args.language_code,
        "languageRouting": "inferred from transcript; language code is receipt metadata",
        "promptSha256": None,
        "quotaProject": auth.get("quota_project"),
    }
    if voice_id:
        settings["voice"]["id"] = voice_id
    if prepared:
        settings["turnManifestSha256"] = prepared["turn_manifest_sha256"]
        settings["speakerVoicesSha256"] = prepared["speaker_voices_sha256"]
    _atomic_write(output, audio)
    print(json.dumps({
        "receipt_schema_version": 1,
        "api": "gemini",
        "output": str(output.resolve()),
        "bytes": len(audio),
        "sha256": _sha256(audio),
        "encoding": args.encoding,
        "voice": speaker_voices if structured else voice_name,
        "voice_id": voice_id,
        "model": model_name,
        "credential_source": credential_source,
        "quota_project": auth.get("quota_project"),
        "source_sample_rate_hertz": source_rate,
        "input_kind": input_kind,
        "input_bytes": len(input_bytes),
        "input_sha256": _sha256(input_bytes),
        "prompt_bytes": 0,
        "prompt_sha256": None,
        "request_sha256": _sha256(_canonical_json_bytes(payload)),
        "settings": settings,
        "settings_sha256": _sha256(_canonical_json_bytes(settings)),
        **({"turn_manifest": prepared["turn_manifest"],
            "turn_manifest_sha256": prepared["turn_manifest_sha256"],
            "speaker_voices_sha256": prepared["speaker_voices_sha256"]} if prepared else {}),
    }, indent=2))


def command_synthesize(args: argparse.Namespace) -> None:
    quota_project_override = _quota_project_override(args)
    voice_id = getattr(args, "voice_id", None)
    if voice_id is not None and (args.voice != PERSONAL_VOICE or not voice_id.strip()):
        raise TtsError('--voice-id requires --voice "Personal Voice" and a nonempty stored voice ID')
    content, input_kind = _read_input(args)
    is_ssml = input_kind == "ssml"
    is_multi_speaker = input_kind == "multi"
    prompt = _read_prompt(args)
    if is_multi_speaker or input_kind == "turns":
        byte_count = sum(len(turn["text"].encode("utf-8")) for turn in content)
    else:
        byte_count = len(content.encode("utf-8"))
    if byte_count == 0:
        raise TtsError("The input is empty")

    voice_name, model_name = _resolve_voice_settings(
        args.language_code,
        args.voice,
        args.model_name,
    )
    if voice_name == PERSONAL_VOICE or model_name == DEFAULT_GEMINI_MODEL:
        _command_gemini_synthesize(args, content, input_kind, voice_name, model_name)
        return
    if input_kind == "turns":
        raise TtsError("--turns-file supports only --model-name gemini-3.8-flash-tts; Cloud input remains unchanged")
    if getattr(args, "api_key_file", None) is not None:
        raise TtsError("--api-key-file is supported only by the Gemini API synthesis path, not Cloud TTS")
    is_gemini = _is_gemini_model(model_name)
    if not is_gemini and not args.allow_non_gemini:
        raise TtsError(
            "This request resolves to standard Cloud TTS. Pass a Gemini --model-name, or use "
            "--allow-non-gemini only after the fallback has been approved"
        )
    speaker_voices = _parse_speaker_voices(args.speaker_voice)
    if is_multi_speaker:
        if not is_gemini:
            raise TtsError("Multi-speaker synthesis requires a Gemini TTS model")
        if args.voice is not None:
            raise TtsError("Use --speaker-voice instead of --voice for multi-speaker synthesis")
        if len(speaker_voices) != 2:
            raise TtsError("Multi-speaker synthesis requires exactly two --speaker-voice values")
        turn_speakers = {turn["speaker"] for turn in content}
        if turn_speakers != set(speaker_voices):
            raise TtsError(
                "Multi-speaker turn aliases must exactly match the two --speaker-voice aliases"
            )
    elif speaker_voices:
        raise TtsError("--speaker-voice requires --multi-speaker-file")
    if is_gemini:
        if not voice_name and not is_multi_speaker:
            raise TtsError("Gemini TTS requires a named voice")
        if is_ssml:
            raise TtsError("Gemini TTS requires text input. Use a non-Gemini voice for SSML")
        prompt_byte_count = len((prompt or "").encode("utf-8"))
        if byte_count > GEMINI_FIELD_BYTE_LIMIT:
            raise TtsError(
                f"Gemini TTS text is {byte_count} UTF-8 bytes. "
                f"The text field allows at most {GEMINI_FIELD_BYTE_LIMIT:,}"
            )
        if prompt_byte_count > GEMINI_FIELD_BYTE_LIMIT:
            raise TtsError(
                f"Gemini TTS prompt is {prompt_byte_count} UTF-8 bytes. "
                f"The prompt field allows at most {GEMINI_FIELD_BYTE_LIMIT:,}"
            )
        if byte_count + prompt_byte_count > GEMINI_TOTAL_INPUT_BYTE_LIMIT:
            raise TtsError(
                f"Gemini TTS text and prompt total {byte_count + prompt_byte_count} UTF-8 bytes. "
                f"The combined limit is {GEMINI_TOTAL_INPUT_BYTE_LIMIT:,}"
            )
    else:
        if byte_count > STANDARD_INPUT_BYTE_LIMIT:
            raise TtsError(
                f"Input is {byte_count} UTF-8 bytes. "
                f"Standard Google TTS allows at most {STANDARD_INPUT_BYTE_LIMIT:,} per request"
            )
        if prompt is not None:
            raise TtsError("Style prompts require a Gemini TTS model")

    output = Path(args.output).expanduser()
    expected_extension = ENCODING_EXTENSIONS[args.encoding]
    if output.suffix.lower() != expected_extension:
        raise TtsError(f"{args.encoding} output should use the {expected_extension} extension")
    if output.exists() and not args.force:
        raise TtsError(f"Output already exists: {output}. Use --force only when replacement is intended")
    if args.speaking_rate is not None and not 0.25 <= args.speaking_rate <= 2.0:
        raise TtsError("--speaking-rate must be between 0.25 and 2.0")
    if args.pitch is not None and not -20.0 <= args.pitch <= 20.0:
        raise TtsError("--pitch must be between -20.0 and 20.0")
    if args.volume_gain_db is not None and not -96.0 <= args.volume_gain_db <= 16.0:
        raise TtsError("--volume-gain-db must be between -96.0 and 16.0")
    if args.sample_rate_hertz is not None and args.sample_rate_hertz <= 0:
        raise TtsError("--sample-rate-hertz must be positive")
    if is_gemini and any([
        args.speaking_rate is not None,
        args.pitch is not None,
        args.volume_gain_db is not None,
        args.effects_profile_id,
    ]):
        raise TtsError(
            "Omit numeric speaking rate, pitch, volume gain, and effects profiles for Gemini TTS; "
            "these controls are unsupported on this path"
        )

    voice: dict[str, object] = {"languageCode": args.language_code}
    if voice_name and not is_multi_speaker:
        voice["name"] = voice_name
    if model_name:
        voice["modelName"] = model_name
    if is_multi_speaker:
        voice["multiSpeakerVoiceConfig"] = {
            "speakerVoiceConfigs": [
                {"speakerAlias": alias, "speakerId": speaker_id}
                for alias, speaker_id in speaker_voices.items()
            ]
        }
    if args.gender:
        voice["ssmlGender"] = args.gender
    audio_config: dict[str, object] = {
        "audioEncoding": args.encoding,
    }
    if args.speaking_rate is not None:
        audio_config["speakingRate"] = args.speaking_rate
    if args.pitch is not None:
        audio_config["pitch"] = args.pitch
    if args.volume_gain_db is not None:
        audio_config["volumeGainDb"] = args.volume_gain_db
    if args.sample_rate_hertz:
        audio_config["sampleRateHertz"] = args.sample_rate_hertz
    if args.effects_profile_id:
        audio_config["effectsProfileId"] = args.effects_profile_id
    if is_multi_speaker:
        synthesis_input = {"multiSpeakerMarkup": {"turns": content}}
    else:
        synthesis_input = {"ssml" if is_ssml else "text": content}
    if prompt is not None:
        synthesis_input["prompt"] = prompt
    payload = {
        "input": synthesis_input,
        "voice": voice,
        "audioConfig": audio_config,
    }
    if is_multi_speaker:
        input_bytes = _canonical_json_bytes(content)
    else:
        input_bytes = content.encode("utf-8")
    prompt_bytes = None if prompt is None else prompt.encode("utf-8")
    prompt_sha256 = None if prompt_bytes is None else _sha256(prompt_bytes)
    settings = {
        "inputKind": input_kind,
        "voice": voice,
        "audioConfig": audio_config,
        "promptSha256": prompt_sha256,
    }
    settings_bytes = _canonical_json_bytes(settings)
    token, quota_project, credential_source = credentials()
    quota_project = quota_project_override or quota_project
    response = _json_request(
        f"{API_ROOT}/text:synthesize",
        method="POST",
        data=payload,
        token=token,
        quota_project=quota_project,
        timeout=GEMINI_REQUEST_TIMEOUT_SECONDS if is_gemini else STANDARD_REQUEST_TIMEOUT_SECONDS,
    )
    try:
        audio = base64.b64decode(response["audioContent"], validate=True)
    except (KeyError, ValueError) as exc:
        raise TtsError("Google TTS response did not contain valid audio") from exc
    if not audio:
        raise TtsError("Google TTS returned empty audio")
    _validate_audio_signature(audio, args.encoding)
    _atomic_write(output, audio)
    print(json.dumps({
        "receipt_schema_version": 1,
        "output": str(output.resolve()),
        "bytes": len(audio),
        "sha256": _sha256(audio),
        "encoding": args.encoding,
        "voice": speaker_voices if is_multi_speaker else voice_name,
        "model": model_name,
        "credential_source": credential_source,
        "quota_project": quota_project,
        "input_kind": input_kind,
        "input_bytes": len(input_bytes),
        "input_sha256": _sha256(input_bytes),
        "prompt_bytes": 0 if prompt_bytes is None else len(prompt_bytes),
        "prompt_sha256": prompt_sha256,
        "request_sha256": _sha256(_canonical_json_bytes(payload)),
        "settings": settings,
        "settings_sha256": _sha256(settings_bytes),
    }, indent=2))


def command_auth_check(args: argparse.Namespace) -> None:
    quota_project_override = _quota_project_override(args)
    if getattr(args, "api", "cloud") == "gemini" or getattr(args, "voice", None) == PERSONAL_VOICE:
        model = getattr(args, "model_name", None) or DEFAULT_GEMINI_MODEL
        auth, credential_source = _gemini_auth(
            quota_project_override, api_key_file=getattr(args, "api_key_file", None),
        )
        response = _json_request(
            f"{GEMINI_API_ROOT}/models/{urllib.parse.quote(model, safe='')}",
            **auth,
        )
        if not isinstance(response, dict) or not response.get("name"):
            raise TtsError("Gemini model lookup did not return model metadata")
        print(json.dumps({
            "authenticated": True,
            "credential_source": credential_source,
            "quota_project": auth.get("quota_project"),
            "api": "gemini",
            "model": model,
            "model_access": True,
            "gemini_synthesis_checked": False,
            "personal_voice_checked": False,
        }, indent=2))
        return
    if getattr(args, "api_key_file", None) is not None:
        raise TtsError("Use --api gemini with --api-key-file; Cloud TTS uses OAuth credentials")
    token, quota_project, source = credentials()
    quota_project = quota_project_override or quota_project
    response = _json_request(f"{API_ROOT}/voices?languageCode=en-US", token=token, quota_project=quota_project)
    print(json.dumps({
        "authenticated": True,
        "credential_source": source,
        "quota_project": quota_project,
        "tts_api_access": True,
        "gemini_synthesis_checked": False,
        "voices_returned": len(response.get("voices", [])),
        "default_en_us_voice": DEFAULT_SYNTHESIS_BY_LANGUAGE["en-US"]["voice"],
        "default_en_us_model": DEFAULT_SYNTHESIS_BY_LANGUAGE["en-US"]["model"],
    }, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    auth = subparsers.add_parser("auth-check", help="Verify credentials and TTS API access")
    auth.add_argument("--api", choices=["cloud", "gemini"], default="cloud")
    auth.add_argument("--model-name", default=DEFAULT_GEMINI_MODEL)
    auth.add_argument("--voice", help="Personal Voice selects the Gemini API authentication check")
    auth.add_argument("--quota-project", help="Override the OAuth quota project for this command; incompatible with Gemini API-key authentication")
    auth.add_argument("--api-key-file", help="Explicit owner-only Gemini API-key file; incompatible with GEMINI_API_KEY and --quota-project")
    auth.set_defaults(func=command_auth_check)

    voices = subparsers.add_parser("voices", help="List live Google TTS voices")
    voices.add_argument("--language-code", help="BCP-47 language code such as pt-BR")
    voices.add_argument("--json", action="store_true", help="Print the full voice records as JSON")
    voices.set_defaults(func=command_voices)

    synth = subparsers.add_parser("synthesize", help="Create an audio file")
    source = synth.add_argument_group("input")
    source.add_argument("--text")
    source.add_argument("--input-file")
    source.add_argument("--ssml")
    source.add_argument("--ssml-file")
    source.add_argument(
        "--multi-speaker-file",
        help="JSON file containing a turns list with speaker and text fields",
    )
    source.add_argument("--turns-file", help="Gemini 3.8 JSON object with exact speaker/text turns and optional short style phrases")
    synth.add_argument("--prompt", help="Cloud Gemini TTS instructions only; forbidden for Gemini 3.8 and Personal Voice")
    synth.add_argument("--prompt-file", help="File containing Gemini TTS delivery instructions")
    synth.add_argument("--language-code", required=True, help="BCP-47 language code such as en-US")
    synth.add_argument(
        "--voice",
        help="Google voice name or Personal Voice; en-US defaults to Charon",
    )
    synth.add_argument(
        "--model-name",
        help="Google TTS model name; en-US defaults to gemini-3.1-flash-tts-preview; Personal Voice uses gemini-3.8-flash-tts",
    )
    synth.add_argument(
        "--allow-non-gemini",
        action="store_true",
        help="Acknowledge an approved standard Cloud TTS fallback; required without a Gemini model",
    )
    synth.add_argument(
        "--speaker-voice",
        action="append",
        default=[],
        metavar="ALIAS=VOICE",
        help="Map ALIAS=VOICE; one or two for --turns-file, exactly two for Cloud --multi-speaker-file",
    )
    synth.add_argument("--voice-id", help="Stored Gemini voice ID; requires --voice Personal Voice")
    synth.add_argument("--quota-project", help="Override the OAuth quota project for this command; incompatible with Gemini API-key authentication")
    synth.add_argument("--api-key-file", help="Explicit owner-only Gemini API-key file; incompatible with GEMINI_API_KEY and --quota-project")
    synth.add_argument("--gender", choices=["MALE", "FEMALE", "NEUTRAL"])
    synth.add_argument("--encoding", choices=sorted(ENCODING_EXTENSIONS), default="MP3")
    synth.add_argument("--speaking-rate", type=float)
    synth.add_argument("--pitch", type=float)
    synth.add_argument("--volume-gain-db", type=float)
    synth.add_argument("--sample-rate-hertz", type=int)
    synth.add_argument("--effects-profile-id", action="append", default=[])
    synth.add_argument("--output", required=True)
    synth.add_argument("--force", action="store_true")
    synth.set_defaults(func=command_synthesize)
    return parser


def main() -> int:
    try:
        args = build_parser().parse_args()
        args.func(args)
        return 0
    except (TtsError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
