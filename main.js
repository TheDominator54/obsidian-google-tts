const { Plugin, PluginSettingTab, Setting, MarkdownView, Notice, FuzzySuggestModal, TFolder } = require('obsidian');
const { setIcon, setTooltip } = require('obsidian');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const BUNDLED_HELPER = "#!/usr/bin/env python3\n\"\"\"Dependency-light client for Google Cloud TTS and Gemini speech generation.\"\"\"\n\nfrom __future__ import annotations\n\nimport argparse\nimport base64\nfrom email.utils import parsedate_to_datetime\nimport hashlib\nimport io\nimport json\nimport math\nimport os\nfrom pathlib import Path\nimport re\nimport shutil\nimport subprocess\nimport sys\nimport tempfile\nimport time\nimport urllib.error\nimport urllib.parse\nimport urllib.request\nimport wave\n\n\nAPI_ROOT = \"https://texttospeech.googleapis.com/v1\"\nGEMINI_API_ROOT = \"https://generativelanguage.googleapis.com/v1beta\"\nDEFAULT_GEMINI_MODEL = \"gemini-3.8-flash-tts\"  # Explicit Gemini API / Personal Voice route.\nDEFAULT_SYNTHESIS_MODEL = \"gemini-3.1-flash-tts-preview\"\nPERSONAL_VOICE = \"Personal Voice\"\nPERSONAL_VOICE_TEMPERATURE = 1.4\nSCOPE = \"https://www.googleapis.com/auth/cloud-platform\"\nSKILL_ADC = Path.home() / \".config\" / \"google-tts-skill\" / \"application_default_credentials.json\"\nGCLOUD_ADC = Path.home() / \".config\" / \"gcloud\" / \"application_default_credentials.json\"\nENCODING_EXTENSIONS = {\"MP3\": \".mp3\", \"LINEAR16\": \".wav\", \"OGG_OPUS\": \".ogg\"}\nDEFAULT_SYNTHESIS_BY_LANGUAGE = {\n    \"en-US\": {\n        \"voice\": \"Charon\",\n        \"model\": DEFAULT_SYNTHESIS_MODEL,\n    },\n}\nSTANDARD_INPUT_BYTE_LIMIT = 5000\nGEMINI_FIELD_BYTE_LIMIT = 4000\nGEMINI_TOTAL_INPUT_BYTE_LIMIT = 8000\nSTANDARD_REQUEST_TIMEOUT_SECONDS = 60\nGEMINI_REQUEST_TIMEOUT_SECONDS = 240\nGEMINI_STYLE_BYTE_LIMIT = 120\n\n\nclass TtsError(RuntimeError):\n    def __init__(\n        self,\n        message: str,\n        *,\n        http_status: int | None = None,\n        google_status: str | None = None,\n        transient: bool | None = None,\n        retry_after: str | None = None,\n        retry_after_seconds: float | None = None,\n    ) -> None:\n        super().__init__(message)\n        self.http_status = http_status\n        self.google_status = google_status\n        self.transient = transient\n        self.retry_after = retry_after\n        self.retry_after_seconds = retry_after_seconds\n\n\ndef _read_utf8(path: str | Path) -> str:\n    \"\"\"Decode UTF-8 without universal-newline translation.\"\"\"\n    return Path(path).read_bytes().decode(\"utf-8\")\n\n\ndef _canonical_json_bytes(value: object) -> bytes:\n    return json.dumps(\n        value,\n        ensure_ascii=False,\n        sort_keys=True,\n        separators=(\",\", \":\"),\n    ).encode(\"utf-8\")\n\n\ndef _sha256(data: bytes) -> str:\n    return hashlib.sha256(data).hexdigest()\n\n\ndef _parse_retry_after(value: str | None) -> float | None:\n    if value is None:\n        return None\n    try:\n        return max(0.0, float(value))\n    except ValueError:\n        try:\n            retry_at = parsedate_to_datetime(value)\n            return max(0.0, retry_at.timestamp() - time.time())\n        except (TypeError, ValueError, OverflowError):\n            return None\n\n\ndef _google_retry_delay(error: dict) -> float | None:\n    \"\"\"Read a nonnegative protobuf Duration from Google RPC RetryInfo.\"\"\"\n    details = error.get(\"details\", [])\n    if not isinstance(details, list):\n        return None\n    for detail in details:\n        if not isinstance(detail, dict) or detail.get(\"@type\") != \"type.googleapis.com/google.rpc.RetryInfo\":\n            continue\n        duration = detail.get(\"retryDelay\")\n        if not isinstance(duration, str) or not re.fullmatch(r\"[0-9]+(?:\\.[0-9]{1,9})?s\", duration):\n            continue\n        seconds = float(duration[:-1])\n        if math.isfinite(seconds):\n            return seconds\n    return None\n\n\ndef _validate_audio_signature(audio: bytes, encoding: str) -> None:\n    valid = False\n    if encoding == \"MP3\":\n        valid = audio.startswith(b\"ID3\") or (\n            len(audio) >= 2 and audio[0] == 0xFF and audio[1] & 0xE0 == 0xE0\n        )\n    elif encoding == \"LINEAR16\":\n        valid = len(audio) >= 12 and audio.startswith(b\"RIFF\") and audio[8:12] == b\"WAVE\"\n    elif encoding == \"OGG_OPUS\":\n        valid = audio.startswith(b\"OggS\")\n    if not valid:\n        raise TtsError(f\"Google TTS returned audio that does not match {encoding}\")\n\n\ndef _atomic_write(path: Path, data: bytes) -> None:\n    path.parent.mkdir(parents=True, exist_ok=True)\n    temporary_path: Path | None = None\n    try:\n        with tempfile.NamedTemporaryFile(\n            mode=\"wb\",\n            dir=path.parent,\n            prefix=f\".{path.name}.\",\n            suffix=\".tmp\",\n            delete=False,\n        ) as handle:\n            temporary_path = Path(handle.name)\n            handle.write(data)\n            handle.flush()\n            os.fsync(handle.fileno())\n        os.replace(temporary_path, path)\n        temporary_path = None\n    finally:\n        if temporary_path is not None:\n            temporary_path.unlink(missing_ok=True)\n\n\ndef _json_request(url: str, *, method: str = \"GET\", data: dict | None = None,\n                  token: str | None = None, quota_project: str | None = None,\n                  api_key: str | None = None,\n                  timeout: int = STANDARD_REQUEST_TIMEOUT_SECONDS) -> dict | list:\n    body = None if data is None else json.dumps(data).encode(\"utf-8\")\n    headers = {\"Accept\": \"application/json\"}\n    if body is not None:\n        headers[\"Content-Type\"] = \"application/json; charset=utf-8\"\n    if token:\n        headers[\"Authorization\"] = f\"Bearer {token}\"\n    if quota_project:\n        headers[\"x-goog-user-project\"] = quota_project\n    if api_key:\n        headers[\"x-goog-api-key\"] = api_key\n    request = urllib.request.Request(url, data=body, headers=headers, method=method)\n    try:\n        with urllib.request.urlopen(request, timeout=timeout) as response:\n            return json.loads(response.read().decode(\"utf-8\"))\n    except urllib.error.HTTPError as exc:\n        try:\n            detail = exc.read().decode(\"utf-8\", errors=\"replace\")\n        finally:\n            exc.close()\n        google_status = None\n        structured_retry_after = None\n        insufficient_scope = \"ACCESS_TOKEN_SCOPE_INSUFFICIENT\" in detail\n        try:\n            parsed = json.loads(detail)\n            # streamGenerateContent can wrap HTTP errors in a JSON event array.\n            # Preserve HTTP classification even for unfamiliar JSON shapes.\n            events = parsed if isinstance(parsed, list) else [parsed]\n            error = next(\n                (event[\"error\"] for event in events\n                 if isinstance(event, dict) and isinstance(event.get(\"error\"), dict)),\n                None,\n            )\n            if error is not None:\n                if error.get(\"message\") is not None:\n                    detail = str(error[\"message\"])\n                status = error.get(\"status\")\n                google_status = status if isinstance(status, str) else None\n                structured_retry_after = _google_retry_delay(error)\n        except json.JSONDecodeError:\n            pass\n        for secret in (api_key, token):\n            if secret:\n                detail = detail.replace(secret, \"[redacted]\")\n        if (token and url.startswith(GEMINI_API_ROOT + \"/\") and exc.code == 403\n                and (insufficient_scope or \"insufficient authentication scopes\" in detail.lower())):\n            detail += (\" Reconnect the saved Google OAuth login with scripts/oauth_login.py --gemini \"\n                       \"and the existing Desktop OAuth client to grant Gemini API access.\")\n        transient = exc.code == 429 or 500 <= exc.code <= 599\n        retry_after = exc.headers.get(\"Retry-After\") if exc.headers else None\n        retry_after_seconds = (\n            _parse_retry_after(retry_after) if retry_after is not None else structured_retry_after\n        )\n        status_label = f\" ({google_status})\" if google_status else \"\"\n        raise TtsError(\n            f\"Google API HTTP {exc.code}{status_label}: {detail}\",\n            http_status=exc.code,\n            google_status=google_status,\n            transient=transient,\n            retry_after=retry_after,\n            retry_after_seconds=retry_after_seconds,\n        ) from exc\n    except urllib.error.URLError as exc:\n        raise TtsError(f\"Could not reach Google TTS: {exc.reason}\", transient=True) from exc\n    except TimeoutError as exc:\n        raise TtsError(\n            f\"Google TTS did not respond within {timeout} seconds\",\n            transient=True,\n        ) from exc\n\n\ndef _form_post(url: str, values: dict[str, str]) -> dict:\n    body = urllib.parse.urlencode(values).encode(\"ascii\")\n    request = urllib.request.Request(\n        url,\n        data=body,\n        headers={\"Content-Type\": \"application/x-www-form-urlencoded\"},\n        method=\"POST\",\n    )\n    try:\n        with urllib.request.urlopen(request, timeout=60) as response:\n            return json.loads(response.read().decode(\"utf-8\"))\n    except urllib.error.HTTPError as exc:\n        try:\n            detail = exc.read().decode(\"utf-8\", errors=\"replace\")\n        finally:\n            exc.close()\n        raise TtsError(f\"OAuth token request failed with HTTP {exc.code}: {detail}\") from exc\n\n\ndef _b64url(data: bytes) -> str:\n    return base64.urlsafe_b64encode(data).rstrip(b\"=\").decode(\"ascii\")\n\n\ndef _refresh_authorized_user(credential: dict) -> str:\n    result = _form_post(\n        credential.get(\"token_uri\", \"https://oauth2.googleapis.com/token\"),\n        {\n            \"client_id\": credential[\"client_id\"],\n            \"client_secret\": credential[\"client_secret\"],\n            \"refresh_token\": credential[\"refresh_token\"],\n            \"grant_type\": \"refresh_token\",\n        },\n    )\n    try:\n        return result[\"access_token\"]\n    except KeyError as exc:\n        raise TtsError(\"OAuth refresh response did not contain an access token\") from exc\n\n\ndef _service_account_token(credential: dict) -> str:\n    openssl = shutil.which(\"openssl\")\n    if not openssl:\n        raise TtsError(\"A service-account credential requires the openssl command\")\n    now = int(time.time())\n    token_uri = credential.get(\"token_uri\", \"https://oauth2.googleapis.com/token\")\n    header = _b64url(json.dumps({\"alg\": \"RS256\", \"typ\": \"JWT\"}, separators=(\",\", \":\")).encode())\n    claims = _b64url(json.dumps({\n        \"iss\": credential[\"client_email\"],\n        \"scope\": SCOPE,\n        \"aud\": token_uri,\n        \"iat\": now,\n        \"exp\": now + 3600,\n    }, separators=(\",\", \":\")).encode())\n    unsigned = f\"{header}.{claims}\".encode(\"ascii\")\n    key_path = None\n    try:\n        with tempfile.NamedTemporaryFile(\"w\", prefix=\"google-tts-key-\", suffix=\".pem\", delete=False) as key_file:\n            key_path = key_file.name\n            os.chmod(key_path, 0o600)\n            key_file.write(credential[\"private_key\"])\n        signed = subprocess.run(\n            [openssl, \"dgst\", \"-sha256\", \"-sign\", key_path],\n            input=unsigned,\n            capture_output=True,\n            check=True,\n        ).stdout\n    except (KeyError, subprocess.CalledProcessError) as exc:\n        raise TtsError(\"Could not sign a service-account assertion\") from exc\n    finally:\n        if key_path:\n            Path(key_path).unlink(missing_ok=True)\n    assertion = f\"{header}.{claims}.{_b64url(signed)}\"\n    result = _form_post(token_uri, {\n        \"grant_type\": \"urn:ietf:params:oauth:grant-type:jwt-bearer\",\n        \"assertion\": assertion,\n    })\n    try:\n        return result[\"access_token\"]\n    except KeyError as exc:\n        raise TtsError(\"Service-account token response did not contain an access token\") from exc\n\n\ndef _load_credential(path: Path) -> tuple[str, str | None, str]:\n    try:\n        credential = json.loads(path.read_text())\n    except (OSError, json.JSONDecodeError) as exc:\n        raise TtsError(f\"Could not read credential file: {path}\") from exc\n    credential_type = credential.get(\"type\")\n    if credential_type == \"authorized_user\":\n        token = _refresh_authorized_user(credential)\n    elif credential_type == \"service_account\":\n        token = _service_account_token(credential)\n    else:\n        raise TtsError(\n            f\"Unsupported credential type in {path}. Expected authorized_user or service_account, \"\n            \"not an OAuth client-secret download.\"\n        )\n    return token, credential.get(\"quota_project_id\"), str(path)\n\n\ndef credentials() -> tuple[str, str | None, str]:\n    configured = os.environ.get(\"GOOGLE_APPLICATION_CREDENTIALS\")\n    candidates = [Path(configured).expanduser()] if configured else []\n    candidates.extend([SKILL_ADC, GCLOUD_ADC])\n    for path in candidates:\n        if path.is_file():\n            return _load_credential(path)\n    gcloud = shutil.which(\"gcloud\")\n    if gcloud:\n        try:\n            result = subprocess.run(\n                [gcloud, \"auth\", \"application-default\", \"print-access-token\"],\n                check=True,\n                capture_output=True,\n                text=True,\n            )\n            token = result.stdout.strip()\n            if token:\n                return token, None, \"gcloud Application Default Credentials\"\n        except subprocess.CalledProcessError as exc:\n            message = exc.stderr.strip() or \"gcloud could not obtain an ADC token\"\n            raise TtsError(message) from exc\n    raise TtsError(\n        \"No Application Default Credentials found. Run scripts/oauth_login.py with a Desktop app \"\n        \"OAuth client, run 'gcloud auth application-default login', or set \"\n        \"GOOGLE_APPLICATION_CREDENTIALS to a service-account key.\"\n    )\n\n\ndef command_voices(args: argparse.Namespace) -> None:\n    token, quota_project, _ = credentials()\n    query = \"\"\n    if args.language_code:\n        query = \"?\" + urllib.parse.urlencode({\"languageCode\": args.language_code})\n    response = _json_request(f\"{API_ROOT}/voices{query}\", token=token, quota_project=quota_project)\n    voices = response.get(\"voices\", [])\n    if args.json:\n        print(json.dumps(voices, indent=2, ensure_ascii=False))\n        return\n    if not voices:\n        print(\"No voices found.\")\n        return\n    print(\"NAME\\tLANGUAGES\\tGENDER\\tSAMPLE_RATE_HZ\")\n    for voice in sorted(voices, key=lambda item: item.get(\"name\", \"\")):\n        print(\"\\t\".join([\n            voice.get(\"name\", \"\"),\n            \",\".join(voice.get(\"languageCodes\", [])),\n            voice.get(\"ssmlGender\", \"\"),\n            str(voice.get(\"naturalSampleRateHertz\", \"\")),\n        ]))\n\n\ndef _read_input(args: argparse.Namespace) -> tuple[str | list[dict[str, str]], str]:\n    sources = [\n        args.text is not None,\n        args.input_file is not None,\n        args.ssml is not None,\n        args.ssml_file is not None,\n        args.multi_speaker_file is not None,\n        getattr(args, \"turns_file\", None) is not None,\n    ]\n    if sum(sources) != 1:\n        raise TtsError(\n            \"Provide exactly one of --text, --input-file, --ssml, --ssml-file, \"\n            \"--multi-speaker-file, or --turns-file\"\n        )\n    if args.text is not None:\n        return args.text, \"text\"\n    if args.input_file is not None:\n        return _read_utf8(args.input_file), \"text\"\n    if args.ssml is not None:\n        return args.ssml, \"ssml\"\n    if args.ssml_file is not None:\n        return _read_utf8(args.ssml_file), \"ssml\"\n    if getattr(args, \"turns_file\", None) is not None:\n        try:\n            parsed = json.loads(_read_utf8(args.turns_file))\n        except json.JSONDecodeError as exc:\n            raise TtsError(f\"Structured turns input is not valid JSON: {exc}\") from exc\n        return _validate_turn_document(parsed), \"turns\"\n    try:\n        parsed = json.loads(_read_utf8(args.multi_speaker_file))\n    except json.JSONDecodeError as exc:\n        raise TtsError(f\"Multi-speaker input is not valid JSON: {exc}\") from exc\n    turns = parsed.get(\"turns\") if isinstance(parsed, dict) else parsed\n    if not isinstance(turns, list) or not turns:\n        raise TtsError(\"Multi-speaker input must contain a non-empty turns list\")\n    normalized = []\n    for index, turn in enumerate(turns, start=1):\n        if not isinstance(turn, dict):\n            raise TtsError(f\"Multi-speaker turn {index} must be an object\")\n        speaker = turn.get(\"speaker\")\n        text = turn.get(\"text\")\n        if not isinstance(speaker, str) or not speaker.strip():\n            raise TtsError(f\"Multi-speaker turn {index} needs a speaker\")\n        if not isinstance(text, str) or not text.strip():\n            raise TtsError(f\"Multi-speaker turn {index} needs text\")\n        normalized.append({\"speaker\": speaker.strip(), \"text\": text})\n    return normalized, \"multi\"\n\n\ndef _read_prompt(args: argparse.Namespace) -> str | None:\n    sources = [args.prompt is not None, args.prompt_file is not None]\n    if sum(sources) > 1:\n        raise TtsError(\"Provide at most one of --prompt or --prompt-file\")\n    if args.prompt is not None:\n        return args.prompt\n    if args.prompt_file is not None:\n        return _read_utf8(args.prompt_file)\n    return None\n\n\ndef _resolve_voice_settings(\n    language_code: str,\n    requested_voice: str | None,\n    requested_model: str | None,\n) -> tuple[str | None, str | None]:\n    if requested_voice == PERSONAL_VOICE:\n        return PERSONAL_VOICE, requested_model or DEFAULT_GEMINI_MODEL\n    default = DEFAULT_SYNTHESIS_BY_LANGUAGE.get(language_code, {})\n    if requested_voice is None and requested_model is None:\n        return default.get(\"voice\"), default.get(\"model\")\n    if requested_voice is None:\n        return default.get(\"voice\"), requested_model\n    return requested_voice, requested_model or (default.get(\"model\") if requested_voice == default.get(\"voice\") else None)\n\n\ndef _is_gemini_model(model_name: str | None) -> bool:\n    return bool(model_name and model_name.startswith(\"gemini-\"))\n\n\ndef _parse_speaker_voices(values: list[str]) -> dict[str, str]:\n    result = {}\n    for value in values:\n        alias, separator, voice = value.partition(\"=\")\n        alias = alias.strip()\n        voice = voice.strip()\n        if not separator or not alias or not voice:\n            raise TtsError(\"--speaker-voice must use ALIAS=VOICE, such as Derek=Charon\")\n        if alias in result:\n            raise TtsError(f\"Duplicate multi-speaker alias: {alias}\")\n        result[alias] = voice\n    return result\n\n\ndef _validate_turn_document(document: object) -> list[dict[str, str]]:\n    \"\"\"Accept only source turns and optional short delivery metadata, never raw API JSON.\"\"\"\n    if not isinstance(document, dict) or set(document) != {\"turns\"}:\n        raise TtsError('--turns-file must contain exactly {\"turns\": [...]}')\n    turns = document[\"turns\"]\n    if not isinstance(turns, list) or not turns:\n        raise TtsError(\"Structured turns input needs a nonempty turns list\")\n    result = []\n    for index, turn in enumerate(turns, start=1):\n        if not isinstance(turn, dict) or not {\"speaker\", \"text\"} <= set(turn) <= {\"speaker\", \"text\", \"style\"}:\n            raise TtsError(f\"Turn {index} must contain speaker, text, and optionally style only\")\n        speaker, text = turn[\"speaker\"], turn[\"text\"]\n        if not isinstance(speaker, str) or not speaker.strip() or speaker != speaker.strip():\n            raise TtsError(f\"Turn {index} needs a nonempty speaker alias without surrounding whitespace\")\n        if not isinstance(text, str) or not text.strip():\n            raise TtsError(f\"Turn {index} needs nonempty source text\")\n        if \"style\" in turn:\n            style = turn[\"style\"]\n            if (not isinstance(style, str) or not style.strip()\n                    or len(style.encode(\"utf-8\")) > GEMINI_STYLE_BYTE_LIMIT\n                    or any(char in style for char in \"\\r\\n\\t[]<>\")):\n                raise TtsError(f\"Turn {index} style must be a short plain phrase of at most {GEMINI_STYLE_BYTE_LIMIT} UTF-8 bytes\")\n        # Do not trim source text, add speaker labels, or embed delivery cues in it.\n        result.append(dict(turn))\n    return result\n\n\ndef prepare_gemini_turns(document: object, speaker_voices: dict[str, str]) -> dict:\n    \"\"\"Offline preflight for Gemini 3.8 structured turns, shared by CLI and workflows.\n\n    Returns API parts/speech configuration plus exact joined text and a hash-bound\n    turn manifest. A one-speaker repair omits speaker metadata, matching the\n    approved isolated-voice request. This function never rewrites source text.\n    \"\"\"\n    turns = _validate_turn_document(document)\n    if not isinstance(speaker_voices, dict) or len(speaker_voices) not in {1, 2}:\n        raise TtsError(\"Structured turns require one or two --speaker-voice mappings\")\n    for alias, voice in speaker_voices.items():\n        if not isinstance(alias, str) or not alias.strip() or alias != alias.strip():\n            raise TtsError(\"Speaker mappings need nonempty aliases without surrounding whitespace\")\n        if (not isinstance(voice, str) or not re.fullmatch(r\"[A-Za-z][A-Za-z0-9]*\", voice)\n                or voice == PERSONAL_VOICE):\n            raise TtsError(\"Structured turns support named prebuilt voices only; Personal Voice and stored voice IDs remain plain-text only\")\n    if {turn[\"speaker\"] for turn in turns} != set(speaker_voices):\n        raise TtsError(\"Turn speaker aliases must exactly match the --speaker-voice aliases\")\n    text = \"\".join(turn[\"text\"] for turn in turns)\n    if len(text.encode(\"utf-8\")) > GEMINI_FIELD_BYTE_LIMIT:\n        raise TtsError(f\"Use sections of at most {GEMINI_FIELD_BYTE_LIMIT:,} UTF-8 source bytes\")\n    multiple = len(speaker_voices) == 2\n    parts, manifest = [], []\n    for index, turn in enumerate(turns):\n        metadata = {\"speaker\": turn[\"speaker\"]} if multiple else {}\n        if \"style\" in turn:\n            metadata[\"style\"] = turn[\"style\"]\n        part = {\"text\": turn[\"text\"]}\n        if metadata:\n            part[\"speechMetadata\"] = metadata\n        parts.append(part)\n        manifest.append({\n            \"index\": index,\n            **turn,\n            \"voice\": speaker_voices[turn[\"speaker\"]],\n            \"text_sha256\": _sha256(turn[\"text\"].encode(\"utf-8\")),\n            \"speaker_sha256\": _sha256(turn[\"speaker\"].encode(\"utf-8\")),\n            \"style_sha256\": _sha256(turn[\"style\"].encode(\"utf-8\")) if \"style\" in turn else None,\n        })\n    if multiple:\n        speech_config = {\"multiSpeakerVoiceConfig\": {\"speakerVoiceConfigs\": [\n            {\"speaker\": alias, \"voiceConfig\": {\"prebuiltVoiceConfig\": {\"voiceName\": voice}}}\n            for alias, voice in speaker_voices.items()\n        ]}}\n    else:\n        speech_config = {\"voiceConfig\": {\"prebuiltVoiceConfig\": {\"voiceName\": next(iter(speaker_voices.values()))}}}\n    return {\n        \"turns\": turns, \"text\": text, \"parts\": parts, \"speech_config\": speech_config,\n        \"turn_manifest\": manifest,\n        \"turn_manifest_sha256\": _sha256(_canonical_json_bytes(manifest)),\n        \"speaker_voices_sha256\": _sha256(_canonical_json_bytes(speaker_voices)),\n    }\n\n\ndef _quota_project_override(args: argparse.Namespace) -> str | None:\n    requested = getattr(args, \"quota_project\", None)\n    if requested is None:\n        return None\n    if not requested.strip():\n        raise TtsError(\"--quota-project must be a nonempty Google project ID or number\")\n    return requested.strip()\n\n\ndef _gemini_auth(quota_project_override: str | None = None, *, api_key_file: str | None = None) -> tuple[dict[str, str | None], str]:\n    key = os.environ.get(\"GEMINI_API_KEY\", \"\").strip()\n    if api_key_file is not None:\n        if quota_project_override is not None:\n            raise TtsError(\"--api-key-file cannot be combined with --quota-project; an API key selects its own project\")\n        if key:\n            raise TtsError(\"Choose --api-key-file or GEMINI_API_KEY, not both; unset GEMINI_API_KEY to use the file\")\n        path = Path(api_key_file).expanduser().resolve()\n        try:\n            if not path.is_file() or path.stat().st_mode & 0o077:\n                raise TtsError(\"API-key file must be a regular file accessible only to its owner\")\n            key = path.read_text(encoding=\"utf-8\").strip()\n        except (OSError, UnicodeError) as exc:\n            raise TtsError(f\"Could not read API-key file: {path}\") from exc\n        if not key or \"\\n\" in key or \"\\r\" in key:\n            raise TtsError(\"API-key file must contain one nonempty key\")\n        # Treat keys as opaque credentials. Valid keys are not limited to AIza.\n        return {\"api_key\": key}, str(path)\n    if key:\n        if quota_project_override is not None:\n            raise TtsError(\n                \"--quota-project only overrides OAuth quota projects; GEMINI_API_KEY selects its own project. \"\n                \"Unset GEMINI_API_KEY for this command to use the saved OAuth login.\"\n            )\n        return {\"api_key\": key}, \"GEMINI_API_KEY\"\n    try:\n        token, quota_project, source = credentials()\n    except TtsError as exc:\n        if \"invalid_grant\" in str(exc):\n            raise TtsError(\n                \"The saved Google OAuth login was rejected (invalid_grant). \"\n                \"Reconnect with scripts/oauth_login.py --gemini and the existing Desktop OAuth client.\"\n            ) from exc\n        if \"No Application Default Credentials found\" in str(exc):\n            raise TtsError(\n                \"Gemini API speech requires GEMINI_API_KEY or Google OAuth Application Default \"\n                \"Credentials. Reconnect the existing Google login with scripts/oauth_login.py --gemini.\"\n            ) from exc\n        raise\n    return {\"token\": token, \"quota_project\": quota_project_override or quota_project}, source\n\n\ndef _decode_gemini_audio(response: dict | list) -> tuple[bytes, int]:\n    \"\"\"Collect audio from the stream's JSON array, accepting PCM or WAV.\"\"\"\n    events = response if isinstance(response, list) else [response]\n    chunks: list[bytes] = []\n    mime_type = None\n    finish_reason = None\n    for event in events:\n        if not isinstance(event, dict):\n            raise TtsError(\"Gemini returned an invalid stream event\")\n        if event.get(\"error\"):\n            error = event[\"error\"]\n            if not isinstance(error, dict):\n                raise TtsError(\"Gemini returned an invalid stream error; no audio was saved\")\n            code = error.get(\"code\")\n            code = code if isinstance(code, int) else None\n            status = error.get(\"status\")\n            detail = str(error.get(\"message\", \"No error message supplied\"))\n            key = os.environ.get(\"GEMINI_API_KEY\", \"\").strip()\n            if key:\n                detail = detail.replace(key, \"[redacted]\")\n            raise TtsError(\n                f\"Gemini stream error {code or ''} ({status or 'UNKNOWN'}): {detail}\",\n                http_status=code,\n                google_status=status,\n                transient=None if code is None else code == 429 or 500 <= code <= 599,\n                retry_after_seconds=_google_retry_delay(error),\n            )\n        block_reason = event.get(\"promptFeedback\", {}).get(\"blockReason\")\n        if block_reason:\n            raise TtsError(f\"Gemini blocked the request: {block_reason}; no audio was saved\")\n        candidates = event.get(\"candidates\", [])\n        if not isinstance(candidates, list) or len(candidates) > 1:\n            raise TtsError(\"Expected exactly one Gemini audio candidate\")\n        for candidate in candidates:\n            reason = candidate.get(\"finishReason\")\n            if reason:\n                finish_reason = reason\n                if reason != \"STOP\":\n                    raise TtsError(f\"Gemini audio did not complete: {reason}; no audio was saved\")\n            for part in candidate.get(\"content\", {}).get(\"parts\", []):\n                inline = part.get(\"inlineData\") or part.get(\"inline_data\")\n                if not inline:\n                    continue\n                current_mime = inline.get(\"mimeType\", inline.get(\"mime_type\", \"\")).lower()\n                if mime_type is not None and current_mime != mime_type:\n                    raise TtsError(\"Gemini changed audio format within the stream\")\n                mime_type = current_mime\n                try:\n                    chunks.append(base64.b64decode(inline[\"data\"], validate=True))\n                except (KeyError, TypeError, ValueError) as exc:\n                    raise TtsError(\"Gemini returned invalid base64 audio\") from exc\n    audio = b\"\".join(chunks)\n    if not audio or not mime_type:\n        raise TtsError(\"Gemini returned no audio\")\n    if finish_reason != \"STOP\":\n        raise TtsError(\"Gemini stream ended without a completed response; no audio was saved\")\n    media_type, *parameters = mime_type.split(\";\")\n    if media_type.strip() in {\"audio/wav\", \"audio/x-wav\", \"audio/wave\"}:\n        try:\n            with wave.open(io.BytesIO(audio), \"rb\") as wav:\n                if wav.getnchannels() != 1 or wav.getsampwidth() != 2:\n                    raise TtsError(\"Expected mono 16-bit Gemini WAV audio\")\n                sample_rate = wav.getframerate()\n                expected_bytes = wav.getnframes() * 2\n                pcm = wav.readframes(wav.getnframes())\n                if len(pcm) != expected_bytes:\n                    raise TtsError(\"Gemini returned a truncated WAV\")\n        except (wave.Error, EOFError) as exc:\n            raise TtsError(\"Gemini returned an invalid WAV\") from exc\n    elif media_type.strip() in {\"audio/l16\", \"audio/pcm\"}:\n        properties = dict(\n            (key.strip(), value.strip())\n            for parameter in parameters\n            for key, separator, value in [parameter.partition(\"=\")]\n            if separator\n        )\n        if properties.get(\"codec\", \"pcm\") != \"pcm\" or properties.get(\"channels\", \"1\") != \"1\":\n            raise TtsError(\"Expected mono PCM Gemini audio\")\n        try:\n            sample_rate = int(properties.get(\"rate\", \"24000\"))\n        except ValueError as exc:\n            raise TtsError(\"Gemini returned an invalid PCM sample rate\") from exc\n        pcm = audio\n    else:\n        raise TtsError(f\"Unsupported Gemini audio MIME type: {mime_type}\")\n    if not pcm or len(pcm) % 2 or sample_rate <= 0:\n        raise TtsError(\"Gemini returned empty or incomplete 16-bit PCM audio\")\n    return pcm, sample_rate\n\n\ndef _encode_gemini_audio(pcm: bytes, sample_rate: int, args: argparse.Namespace) -> bytes:\n    wav_buffer = io.BytesIO()\n    with wave.open(wav_buffer, \"wb\") as wav:\n        wav.setnchannels(1)\n        wav.setsampwidth(2)\n        wav.setframerate(sample_rate)\n        wav.writeframes(pcm)\n    if args.encoding == \"LINEAR16\" and args.sample_rate_hertz in {None, sample_rate}:\n        return wav_buffer.getvalue()\n    ffmpeg = shutil.which(\"ffmpeg\")\n    if not ffmpeg:\n        raise TtsError(\"Install ffmpeg for Gemini MP3/OGG output or sample-rate conversion\")\n    with tempfile.TemporaryDirectory(prefix=\"google-tts-\") as directory:\n        source = Path(directory) / \"source.wav\"\n        target = Path(directory) / (\"output\" + ENCODING_EXTENSIONS[args.encoding])\n        source.write_bytes(wav_buffer.getvalue())\n        command = [ffmpeg, \"-v\", \"error\", \"-nostdin\", \"-i\", str(source)]\n        if args.sample_rate_hertz:\n            command += [\"-ar\", str(args.sample_rate_hertz)]\n        command += [\"-c:a\", {\"LINEAR16\": \"pcm_s16le\", \"MP3\": \"libmp3lame\", \"OGG_OPUS\": \"libopus\"}[args.encoding]]\n        command += [str(target)]\n        try:\n            subprocess.run(command, check=True, capture_output=True, timeout=60)\n        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:\n            raise TtsError(\"ffmpeg could not convert Gemini audio; no output was replaced\") from exc\n        return target.read_bytes()\n\n\ndef _command_gemini_synthesize(\n    args: argparse.Namespace,\n    content: str | list[dict[str, str]],\n    input_kind: str,\n    voice_name: str | None,\n    model_name: str | None,\n) -> None:\n    structured = input_kind == \"turns\"\n    prepared = None\n    speaker_voices = {}\n    if structured:\n        if model_name != DEFAULT_GEMINI_MODEL or args.voice is not None or getattr(args, \"voice_id\", None) is not None:\n            raise TtsError(\"--turns-file requires Gemini 3.8 and --speaker-voice mappings, without --voice or --voice-id\")\n        speaker_voices = _parse_speaker_voices(args.speaker_voice)\n        prepared = prepare_gemini_turns({\"turns\": content}, speaker_voices)\n    elif input_kind != \"text\" or args.speaker_voice:\n        raise TtsError(\"Gemini API synthesis requires plain text and one voice per call, or --turns-file with prebuilt speaker mappings\")\n    if _read_prompt(args) is not None:\n        raise TtsError(\"Gemini API --prompt and --prompt-file are forbidden. Prebuilt voices may use short style metadata in --turns-file; Personal Voice remains plain-text only\")\n    if (not voice_name and not structured) or not _is_gemini_model(model_name):\n        raise TtsError(\"Gemini API synthesis requires a named voice and a Gemini model\")\n    if any([args.speaking_rate is not None, args.pitch is not None,\n            args.volume_gain_db is not None, args.effects_profile_id, args.gender]):\n        raise TtsError(\"Gemini API synthesis uses a named voice without numeric voice controls or gender\")\n    if args.sample_rate_hertz is not None and args.sample_rate_hertz <= 0:\n        raise TtsError(\"--sample-rate-hertz must be positive\")\n    # Keep requests bounded for section-based narration; this is a helper ceiling,\n    # not a claim about the Gemini API's token-based context limit.\n    source_text = prepared[\"text\"] if prepared else content\n    input_bytes = source_text.encode(\"utf-8\")\n    if not source_text.strip() or len(input_bytes) > GEMINI_FIELD_BYTE_LIMIT:\n        raise TtsError(f\"Use nonempty sections of at most {GEMINI_FIELD_BYTE_LIMIT:,} UTF-8 bytes\")\n    output = Path(args.output).expanduser()\n    extension = ENCODING_EXTENSIONS[args.encoding]\n    if output.suffix.lower() != extension:\n        raise TtsError(f\"{args.encoding} output should use the {extension} extension\")\n    if output.exists() and not args.force:\n        raise TtsError(f\"Output already exists: {output}. Use --force only when replacement is intended\")\n    if (args.encoding != \"LINEAR16\" or args.sample_rate_hertz not in {None, 24000}) and not shutil.which(\"ffmpeg\"):\n        raise TtsError(\"Install ffmpeg for Gemini MP3/OGG output or sample-rate conversion\")\n    voice_id = getattr(args, \"voice_id\", None)\n    if voice_id is not None:\n        voice_id = voice_id.strip()\n        if args.voice != PERSONAL_VOICE or not voice_id:\n            raise TtsError('--voice-id requires --voice \"Personal Voice\" and a nonempty stored voice ID')\n    auth, credential_source = _gemini_auth(\n        _quota_project_override(args), api_key_file=getattr(args, \"api_key_file\", None),\n    )\n    voice_config = {\"voice\": voice_id} if voice_id else {\"prebuiltVoiceConfig\": {\"voiceName\": voice_name}}\n    generation_config = {\n        \"responseModalities\": [\"AUDIO\"],\n        \"speechConfig\": prepared[\"speech_config\"] if prepared else {\"voiceConfig\": voice_config},\n    }\n    if voice_name == PERSONAL_VOICE and not structured:\n        generation_config[\"temperature\"] = PERSONAL_VOICE_TEMPERATURE\n    payload = {\n        \"contents\": [{\"role\": \"user\", \"parts\": prepared[\"parts\"] if prepared else [{\"text\": content}]}],\n        \"generationConfig\": generation_config,\n    }\n    endpoint = f\"{GEMINI_API_ROOT}/models/{urllib.parse.quote(model_name, safe='')}:streamGenerateContent\"\n    response = _json_request(endpoint, method=\"POST\", data=payload, **auth,\n                             timeout=GEMINI_REQUEST_TIMEOUT_SECONDS)\n    try:\n        pcm, source_rate = _decode_gemini_audio(response)\n    except TtsError as exc:\n        # A streamed error can arrive in HTTP 200, outside _json_request's\n        # redaction path. Cover explicitly loaded keys and OAuth tokens too.\n        message = str(exc)\n        for credential_name in (\"api_key\", \"token\"):\n            secret = auth.get(credential_name)\n            if secret:\n                message = message.replace(secret, \"[redacted]\")\n        exc.args = (message,)\n        raise\n    audio = _encode_gemini_audio(pcm, source_rate, args)\n    _validate_audio_signature(audio, args.encoding)\n    settings = {\n        \"api\": \"gemini\",\n        \"method\": \"streamGenerateContent\",\n        \"inputKind\": input_kind,\n        \"voice\": ({\"speakers\": speaker_voices, \"modelName\": model_name} if structured\n                  else {\"name\": voice_name, \"modelName\": model_name}),\n        \"generationConfig\": generation_config,\n        \"audioConfig\": {\"audioEncoding\": args.encoding, \"sampleRateHertz\": args.sample_rate_hertz},\n        \"languageCode\": args.language_code,\n        \"languageRouting\": \"inferred from transcript; language code is receipt metadata\",\n        \"promptSha256\": None,\n        \"quotaProject\": auth.get(\"quota_project\"),\n    }\n    if voice_id:\n        settings[\"voice\"][\"id\"] = voice_id\n    if prepared:\n        settings[\"turnManifestSha256\"] = prepared[\"turn_manifest_sha256\"]\n        settings[\"speakerVoicesSha256\"] = prepared[\"speaker_voices_sha256\"]\n    _atomic_write(output, audio)\n    print(json.dumps({\n        \"receipt_schema_version\": 1,\n        \"api\": \"gemini\",\n        \"output\": str(output.resolve()),\n        \"bytes\": len(audio),\n        \"sha256\": _sha256(audio),\n        \"encoding\": args.encoding,\n        \"voice\": speaker_voices if structured else voice_name,\n        \"voice_id\": voice_id,\n        \"model\": model_name,\n        \"credential_source\": credential_source,\n        \"quota_project\": auth.get(\"quota_project\"),\n        \"source_sample_rate_hertz\": source_rate,\n        \"input_kind\": input_kind,\n        \"input_bytes\": len(input_bytes),\n        \"input_sha256\": _sha256(input_bytes),\n        \"prompt_bytes\": 0,\n        \"prompt_sha256\": None,\n        \"request_sha256\": _sha256(_canonical_json_bytes(payload)),\n        \"settings\": settings,\n        \"settings_sha256\": _sha256(_canonical_json_bytes(settings)),\n        **({\"turn_manifest\": prepared[\"turn_manifest\"],\n            \"turn_manifest_sha256\": prepared[\"turn_manifest_sha256\"],\n            \"speaker_voices_sha256\": prepared[\"speaker_voices_sha256\"]} if prepared else {}),\n    }, indent=2))\n\n\ndef command_synthesize(args: argparse.Namespace) -> None:\n    quota_project_override = _quota_project_override(args)\n    voice_id = getattr(args, \"voice_id\", None)\n    if voice_id is not None and (args.voice != PERSONAL_VOICE or not voice_id.strip()):\n        raise TtsError('--voice-id requires --voice \"Personal Voice\" and a nonempty stored voice ID')\n    content, input_kind = _read_input(args)\n    is_ssml = input_kind == \"ssml\"\n    is_multi_speaker = input_kind == \"multi\"\n    prompt = _read_prompt(args)\n    if is_multi_speaker or input_kind == \"turns\":\n        byte_count = sum(len(turn[\"text\"].encode(\"utf-8\")) for turn in content)\n    else:\n        byte_count = len(content.encode(\"utf-8\"))\n    if byte_count == 0:\n        raise TtsError(\"The input is empty\")\n\n    voice_name, model_name = _resolve_voice_settings(\n        args.language_code,\n        args.voice,\n        args.model_name,\n    )\n    if voice_name == PERSONAL_VOICE or model_name == DEFAULT_GEMINI_MODEL:\n        _command_gemini_synthesize(args, content, input_kind, voice_name, model_name)\n        return\n    if input_kind == \"turns\":\n        raise TtsError(\"--turns-file supports only --model-name gemini-3.8-flash-tts; Cloud input remains unchanged\")\n    if getattr(args, \"api_key_file\", None) is not None:\n        raise TtsError(\"--api-key-file is supported only by the Gemini API synthesis path, not Cloud TTS\")\n    is_gemini = _is_gemini_model(model_name)\n    if not is_gemini and not args.allow_non_gemini:\n        raise TtsError(\n            \"This request resolves to standard Cloud TTS. Pass a Gemini --model-name, or use \"\n            \"--allow-non-gemini only after the fallback has been approved\"\n        )\n    speaker_voices = _parse_speaker_voices(args.speaker_voice)\n    if is_multi_speaker:\n        if not is_gemini:\n            raise TtsError(\"Multi-speaker synthesis requires a Gemini TTS model\")\n        if args.voice is not None:\n            raise TtsError(\"Use --speaker-voice instead of --voice for multi-speaker synthesis\")\n        if len(speaker_voices) != 2:\n            raise TtsError(\"Multi-speaker synthesis requires exactly two --speaker-voice values\")\n        turn_speakers = {turn[\"speaker\"] for turn in content}\n        if turn_speakers != set(speaker_voices):\n            raise TtsError(\n                \"Multi-speaker turn aliases must exactly match the two --speaker-voice aliases\"\n            )\n    elif speaker_voices:\n        raise TtsError(\"--speaker-voice requires --multi-speaker-file\")\n    if is_gemini:\n        if not voice_name and not is_multi_speaker:\n            raise TtsError(\"Gemini TTS requires a named voice\")\n        if is_ssml:\n            raise TtsError(\"Gemini TTS requires text input. Use a non-Gemini voice for SSML\")\n        prompt_byte_count = len((prompt or \"\").encode(\"utf-8\"))\n        if byte_count > GEMINI_FIELD_BYTE_LIMIT:\n            raise TtsError(\n                f\"Gemini TTS text is {byte_count} UTF-8 bytes. \"\n                f\"The text field allows at most {GEMINI_FIELD_BYTE_LIMIT:,}\"\n            )\n        if prompt_byte_count > GEMINI_FIELD_BYTE_LIMIT:\n            raise TtsError(\n                f\"Gemini TTS prompt is {prompt_byte_count} UTF-8 bytes. \"\n                f\"The prompt field allows at most {GEMINI_FIELD_BYTE_LIMIT:,}\"\n            )\n        if byte_count + prompt_byte_count > GEMINI_TOTAL_INPUT_BYTE_LIMIT:\n            raise TtsError(\n                f\"Gemini TTS text and prompt total {byte_count + prompt_byte_count} UTF-8 bytes. \"\n                f\"The combined limit is {GEMINI_TOTAL_INPUT_BYTE_LIMIT:,}\"\n            )\n    else:\n        if byte_count > STANDARD_INPUT_BYTE_LIMIT:\n            raise TtsError(\n                f\"Input is {byte_count} UTF-8 bytes. \"\n                f\"Standard Google TTS allows at most {STANDARD_INPUT_BYTE_LIMIT:,} per request\"\n            )\n        if prompt is not None:\n            raise TtsError(\"Style prompts require a Gemini TTS model\")\n\n    output = Path(args.output).expanduser()\n    expected_extension = ENCODING_EXTENSIONS[args.encoding]\n    if output.suffix.lower() != expected_extension:\n        raise TtsError(f\"{args.encoding} output should use the {expected_extension} extension\")\n    if output.exists() and not args.force:\n        raise TtsError(f\"Output already exists: {output}. Use --force only when replacement is intended\")\n    if args.speaking_rate is not None and not 0.25 <= args.speaking_rate <= 2.0:\n        raise TtsError(\"--speaking-rate must be between 0.25 and 2.0\")\n    if args.pitch is not None and not -20.0 <= args.pitch <= 20.0:\n        raise TtsError(\"--pitch must be between -20.0 and 20.0\")\n    if args.volume_gain_db is not None and not -96.0 <= args.volume_gain_db <= 16.0:\n        raise TtsError(\"--volume-gain-db must be between -96.0 and 16.0\")\n    if args.sample_rate_hertz is not None and args.sample_rate_hertz <= 0:\n        raise TtsError(\"--sample-rate-hertz must be positive\")\n    if is_gemini and any([\n        args.speaking_rate is not None,\n        args.pitch is not None,\n        args.volume_gain_db is not None,\n        args.effects_profile_id,\n    ]):\n        raise TtsError(\n            \"Omit numeric speaking rate, pitch, volume gain, and effects profiles for Gemini TTS; \"\n            \"these controls are unsupported on this path\"\n        )\n\n    voice: dict[str, object] = {\"languageCode\": args.language_code}\n    if voice_name and not is_multi_speaker:\n        voice[\"name\"] = voice_name\n    if model_name:\n        voice[\"modelName\"] = model_name\n    if is_multi_speaker:\n        voice[\"multiSpeakerVoiceConfig\"] = {\n            \"speakerVoiceConfigs\": [\n                {\"speakerAlias\": alias, \"speakerId\": speaker_id}\n                for alias, speaker_id in speaker_voices.items()\n            ]\n        }\n    if args.gender:\n        voice[\"ssmlGender\"] = args.gender\n    audio_config: dict[str, object] = {\n        \"audioEncoding\": args.encoding,\n    }\n    if args.speaking_rate is not None:\n        audio_config[\"speakingRate\"] = args.speaking_rate\n    if args.pitch is not None:\n        audio_config[\"pitch\"] = args.pitch\n    if args.volume_gain_db is not None:\n        audio_config[\"volumeGainDb\"] = args.volume_gain_db\n    if args.sample_rate_hertz:\n        audio_config[\"sampleRateHertz\"] = args.sample_rate_hertz\n    if args.effects_profile_id:\n        audio_config[\"effectsProfileId\"] = args.effects_profile_id\n    if is_multi_speaker:\n        synthesis_input = {\"multiSpeakerMarkup\": {\"turns\": content}}\n    else:\n        synthesis_input = {\"ssml\" if is_ssml else \"text\": content}\n    if prompt is not None:\n        synthesis_input[\"prompt\"] = prompt\n    payload = {\n        \"input\": synthesis_input,\n        \"voice\": voice,\n        \"audioConfig\": audio_config,\n    }\n    if is_multi_speaker:\n        input_bytes = _canonical_json_bytes(content)\n    else:\n        input_bytes = content.encode(\"utf-8\")\n    prompt_bytes = None if prompt is None else prompt.encode(\"utf-8\")\n    prompt_sha256 = None if prompt_bytes is None else _sha256(prompt_bytes)\n    settings = {\n        \"inputKind\": input_kind,\n        \"voice\": voice,\n        \"audioConfig\": audio_config,\n        \"promptSha256\": prompt_sha256,\n    }\n    settings_bytes = _canonical_json_bytes(settings)\n    token, quota_project, credential_source = credentials()\n    quota_project = quota_project_override or quota_project\n    response = _json_request(\n        f\"{API_ROOT}/text:synthesize\",\n        method=\"POST\",\n        data=payload,\n        token=token,\n        quota_project=quota_project,\n        timeout=GEMINI_REQUEST_TIMEOUT_SECONDS if is_gemini else STANDARD_REQUEST_TIMEOUT_SECONDS,\n    )\n    try:\n        audio = base64.b64decode(response[\"audioContent\"], validate=True)\n    except (KeyError, ValueError) as exc:\n        raise TtsError(\"Google TTS response did not contain valid audio\") from exc\n    if not audio:\n        raise TtsError(\"Google TTS returned empty audio\")\n    _validate_audio_signature(audio, args.encoding)\n    _atomic_write(output, audio)\n    print(json.dumps({\n        \"receipt_schema_version\": 1,\n        \"output\": str(output.resolve()),\n        \"bytes\": len(audio),\n        \"sha256\": _sha256(audio),\n        \"encoding\": args.encoding,\n        \"voice\": speaker_voices if is_multi_speaker else voice_name,\n        \"model\": model_name,\n        \"credential_source\": credential_source,\n        \"quota_project\": quota_project,\n        \"input_kind\": input_kind,\n        \"input_bytes\": len(input_bytes),\n        \"input_sha256\": _sha256(input_bytes),\n        \"prompt_bytes\": 0 if prompt_bytes is None else len(prompt_bytes),\n        \"prompt_sha256\": prompt_sha256,\n        \"request_sha256\": _sha256(_canonical_json_bytes(payload)),\n        \"settings\": settings,\n        \"settings_sha256\": _sha256(settings_bytes),\n    }, indent=2))\n\n\ndef command_auth_check(args: argparse.Namespace) -> None:\n    quota_project_override = _quota_project_override(args)\n    if getattr(args, \"api\", \"cloud\") == \"gemini\" or getattr(args, \"voice\", None) == PERSONAL_VOICE:\n        model = getattr(args, \"model_name\", None) or DEFAULT_GEMINI_MODEL\n        auth, credential_source = _gemini_auth(\n            quota_project_override, api_key_file=getattr(args, \"api_key_file\", None),\n        )\n        response = _json_request(\n            f\"{GEMINI_API_ROOT}/models/{urllib.parse.quote(model, safe='')}\",\n            **auth,\n        )\n        if not isinstance(response, dict) or not response.get(\"name\"):\n            raise TtsError(\"Gemini model lookup did not return model metadata\")\n        print(json.dumps({\n            \"authenticated\": True,\n            \"credential_source\": credential_source,\n            \"quota_project\": auth.get(\"quota_project\"),\n            \"api\": \"gemini\",\n            \"model\": model,\n            \"model_access\": True,\n            \"gemini_synthesis_checked\": False,\n            \"personal_voice_checked\": False,\n        }, indent=2))\n        return\n    if getattr(args, \"api_key_file\", None) is not None:\n        raise TtsError(\"Use --api gemini with --api-key-file; Cloud TTS uses OAuth credentials\")\n    token, quota_project, source = credentials()\n    quota_project = quota_project_override or quota_project\n    response = _json_request(f\"{API_ROOT}/voices?languageCode=en-US\", token=token, quota_project=quota_project)\n    print(json.dumps({\n        \"authenticated\": True,\n        \"credential_source\": source,\n        \"quota_project\": quota_project,\n        \"tts_api_access\": True,\n        \"gemini_synthesis_checked\": False,\n        \"voices_returned\": len(response.get(\"voices\", [])),\n        \"default_en_us_voice\": DEFAULT_SYNTHESIS_BY_LANGUAGE[\"en-US\"][\"voice\"],\n        \"default_en_us_model\": DEFAULT_SYNTHESIS_BY_LANGUAGE[\"en-US\"][\"model\"],\n    }, indent=2))\n\n\ndef build_parser() -> argparse.ArgumentParser:\n    parser = argparse.ArgumentParser(description=__doc__)\n    subparsers = parser.add_subparsers(dest=\"command\", required=True)\n\n    auth = subparsers.add_parser(\"auth-check\", help=\"Verify credentials and TTS API access\")\n    auth.add_argument(\"--api\", choices=[\"cloud\", \"gemini\"], default=\"cloud\")\n    auth.add_argument(\"--model-name\", default=DEFAULT_GEMINI_MODEL)\n    auth.add_argument(\"--voice\", help=\"Personal Voice selects the Gemini API authentication check\")\n    auth.add_argument(\"--quota-project\", help=\"Override the OAuth quota project for this command; incompatible with Gemini API-key authentication\")\n    auth.add_argument(\"--api-key-file\", help=\"Explicit owner-only Gemini API-key file; incompatible with GEMINI_API_KEY and --quota-project\")\n    auth.set_defaults(func=command_auth_check)\n\n    voices = subparsers.add_parser(\"voices\", help=\"List live Google TTS voices\")\n    voices.add_argument(\"--language-code\", help=\"BCP-47 language code such as pt-BR\")\n    voices.add_argument(\"--json\", action=\"store_true\", help=\"Print the full voice records as JSON\")\n    voices.set_defaults(func=command_voices)\n\n    synth = subparsers.add_parser(\"synthesize\", help=\"Create an audio file\")\n    source = synth.add_argument_group(\"input\")\n    source.add_argument(\"--text\")\n    source.add_argument(\"--input-file\")\n    source.add_argument(\"--ssml\")\n    source.add_argument(\"--ssml-file\")\n    source.add_argument(\n        \"--multi-speaker-file\",\n        help=\"JSON file containing a turns list with speaker and text fields\",\n    )\n    source.add_argument(\"--turns-file\", help=\"Gemini 3.8 JSON object with exact speaker/text turns and optional short style phrases\")\n    synth.add_argument(\"--prompt\", help=\"Cloud Gemini TTS instructions only; forbidden for Gemini 3.8 and Personal Voice\")\n    synth.add_argument(\"--prompt-file\", help=\"File containing Gemini TTS delivery instructions\")\n    synth.add_argument(\"--language-code\", required=True, help=\"BCP-47 language code such as en-US\")\n    synth.add_argument(\n        \"--voice\",\n        help=\"Google voice name or Personal Voice; en-US defaults to Charon\",\n    )\n    synth.add_argument(\n        \"--model-name\",\n        help=\"Google TTS model name; en-US defaults to gemini-3.1-flash-tts-preview; Personal Voice uses gemini-3.8-flash-tts\",\n    )\n    synth.add_argument(\n        \"--allow-non-gemini\",\n        action=\"store_true\",\n        help=\"Acknowledge an approved standard Cloud TTS fallback; required without a Gemini model\",\n    )\n    synth.add_argument(\n        \"--speaker-voice\",\n        action=\"append\",\n        default=[],\n        metavar=\"ALIAS=VOICE\",\n        help=\"Map ALIAS=VOICE; one or two for --turns-file, exactly two for Cloud --multi-speaker-file\",\n    )\n    synth.add_argument(\"--voice-id\", help=\"Stored Gemini voice ID; requires --voice Personal Voice\")\n    synth.add_argument(\"--quota-project\", help=\"Override the OAuth quota project for this command; incompatible with Gemini API-key authentication\")\n    synth.add_argument(\"--api-key-file\", help=\"Explicit owner-only Gemini API-key file; incompatible with GEMINI_API_KEY and --quota-project\")\n    synth.add_argument(\"--gender\", choices=[\"MALE\", \"FEMALE\", \"NEUTRAL\"])\n    synth.add_argument(\"--encoding\", choices=sorted(ENCODING_EXTENSIONS), default=\"MP3\")\n    synth.add_argument(\"--speaking-rate\", type=float)\n    synth.add_argument(\"--pitch\", type=float)\n    synth.add_argument(\"--volume-gain-db\", type=float)\n    synth.add_argument(\"--sample-rate-hertz\", type=int)\n    synth.add_argument(\"--effects-profile-id\", action=\"append\", default=[])\n    synth.add_argument(\"--output\", required=True)\n    synth.add_argument(\"--force\", action=\"store_true\")\n    synth.set_defaults(func=command_synthesize)\n    return parser\n\n\ndef main() -> int:\n    try:\n        args = build_parser().parse_args()\n        args.func(args)\n        return 0\n    except (TtsError, OSError, UnicodeError, json.JSONDecodeError) as exc:\n        print(f\"error: {exc}\", file=sys.stderr)\n        return 1\n\n\nif __name__ == \"__main__\":\n    raise SystemExit(main())\n";

const DEFAULTS = {
  python: require('fs').existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3',
  helper: '',
  audioFolder: 'Audio',
  ffmpeg: require('fs').existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg',
  language: 'en-US',
  model: 'gemini-3.1-flash-tts-preview'
};
const MODELS = {
  'gemini-3.1-flash-tts-preview': 'Gemini 3.1 Flash TTS (Preview)',
  'gemini-2.5-flash-tts': 'Gemini 2.5 Flash TTS',
  'gemini-2.5-flash-lite-preview-tts': 'Gemini 2.5 Flash Lite TTS (Preview)',
  'gemini-2.5-pro-tts': 'Gemini 2.5 Pro TTS'
};

// Convert the note to spoken prose without changing its saved Markdown.
function speechText(markdown) {
  return markdown.replace(/\r\n?/g, '\n')
    .replace(/^\uFEFF?---\s*\n[\s\S]*?\n(?:---|\.\.\.)\s*(?:\n|$)/, '')
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/^\s*\[[^\]\n]+\]:\s+\S+.*$/gm, '')
    .replace(/!\[\[[^\]\n]*\]\]/g, '')
    .replace(/!\[([^\]\n]*)\]\([^\n]*?\)/g, '$1')
    .replace(/\[\[([^\]\n]+)\]\]/g, (_, target) => {
      const parts = target.split('|');
      return parts.length > 1 ? parts[parts.length - 1] : target.replace(/^.*#\^?/, '');
    })
    .replace(/\[([^\]\n]+)\]\((?:[^()\n]|\([^()\n]*\))*\)/g, '$1')
    .replace(/\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1')
    .replace(/\[\^[^\]\n]+\]/g, '')
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/^\s*>\s*\[![^\]\n]+\][+-]?\s*/gm, '')
    .replace(/^\s*(?:>\s*)+/gm, '')
    .replace(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/gm, '$1')
    .replace(/^\s*(?:[-*_]\s*){3,}\s*$|^\s*[=-]{2,}\s*$/gm, '')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/gm, '')
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '')
    .replace(/^.*\|.*$/gm, line => line.replace(/^\s*\||\|\s*$/g, '').replace(/\s*\|\s*/g, ', ').trim())
    .replace(/(?:^|\s)\^[\w-]+(?=\s|$)/gm, '')
    .replace(/(^|\s)#(?=[\p{L}\p{N}_/-]+)/gu, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/g, (_, a, b) => a || b)
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)|(?<!\w)_([^_\n]+)_(?!\w)/g, (_, a, b) => a || b)
    .replace(/~~([^\n]+?)~~|==([^\n]+?)==/g, (_, a, b) => a || b)
    .replace(/\\([\\`*{}\[\]()#+.!_>~-])/g, '$1')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' '
    })[entity])
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// First two sentences start playback early; subsequent requests contain more prose.
// A sentence is never split to fit the API. Reject oversized sentences before billing.
function splitText(text, limit = 900, language = 'en-US') {
  const segmenter = new Intl.Segmenter(language, { granularity: 'sentence' });
  const sentences = [];
  for (const paragraph of text.split(/\n\s*\n/u)) {
    for (const { segment } of segmenter.segment(paragraph)) {
      if (segment.trim()) sentences.push(segment.trim());
    }
  }
  const chunks = [];
  let chunk = '';
  for (const sentence of sentences) {
    if (Buffer.byteLength(sentence) > 4000) {
      throw new Error('A sentence exceeds Google’s 4,000-byte limit. Add a sentence break before reading it.');
    }
    if (chunks.length < 2) { chunks.push(sentence); continue; }
    const combined = chunk ? chunk + ' ' + sentence : sentence;
    if (chunk && Buffer.byteLength(combined) > limit) { chunks.push(chunk); chunk = sentence; }
    else chunk = combined;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

function wavDuration(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Google returned an invalid WAV file.');
  }
  let byteRate = 0, dataSize = 0;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4);
    if (offset + 8 + size > bytes.length) throw new Error('Google returned a truncated WAV file.');
    const tag = bytes.toString('ascii', offset, offset + 4);
    if (tag === 'fmt ' && size >= 16) byteRate = bytes.readUInt32LE(offset + 16);
    if (tag === 'data') dataSize += size;
    offset += 8 + size + (size % 2);
  }
  if (!byteRate || !dataSize) throw new Error('Google returned an empty WAV file.');
  return dataSize / byteRate;
}

function audioFolder(value) {
  const folder = String(value ?? 'Audio').trim().replace(/\\/g, '/').replace(/\/$/, '');
  if (!folder || folder === '/') return '';
  if (folder.startsWith('/') || folder.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /[\[\]|#^:\x00-\x1f]/.test(folder)) {
    throw new Error('Choose a normal folder inside this vault, such as Audio or Articles/Audio.');
  }
  return folder;
}

function passageInsertion(source, start, embed) {
  const offset = start ?? (source.match(/^\uFEFF?---[^\S\n]*\n[\s\S]*?\n(?:---|\.\.\.)[^\S\n]*(?:\n|$)/)?.[0].length || 0);
  const prefix = offset && source[offset - 1] !== '\n' ? '\n\n' : '';
  return { offset, text: prefix + embed + '\n\n' };
}

class AudioFolderPicker extends FuzzySuggestModal {
  constructor(app, choose) { super(app); this.choose = choose; this.setPlaceholder('Choose an audio folder in this vault'); }
  getItems() { return this.app.vault.getAllLoadedFiles().filter(file => file instanceof TFolder); }
  getItemText(folder) { return folder.path === '/' ? 'Vault root' : folder.path; }
  onChooseItem(folder) { this.choose(folder.path === '/' ? '' : folder.path); }
}

class GoogleTTS extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.generation = 0;
    this.children = new Set();
    this.status = this.addStatusBarItem();
    this.status.addClass('dom-google-tts-status');
    this.label = this.status.createSpan({ cls: 'dom-google-tts-state', attr: { role: 'status' } });
    this.setStatus('Ready');
    this.generateButton = this.iconButton('audio-lines', 'Generate and play selection or current note', () => this.read());
    this.pauseButton = this.iconButton('pause', 'Pause', () => this.togglePause());
    this.pauseButton.disabled = true;
    this.rewindButton = this.iconButton('rotate-ccw', 'Rewind 10 seconds', () => this.seek(-10));
    this.rewindButton.disabled = true;
    this.forwardButton = this.iconButton('rotate-cw', 'Skip forward 15 seconds', () => this.seek(15));
    this.forwardButton.disabled = true;
    this.stopButton = this.iconButton('square', 'Stop', () => this.stop());
    this.stopButton.disabled = true;
    this.exportButton = this.iconButton('file-audio', 'Save audio and attach to note', () => this.generateArticleAudio());
    this.addRibbonIcon('file-audio', 'Google TTS: Generate article audio and attach', () => this.generateArticleAudio());
    this.addCommand({ id: 'generate-article-audio', name: 'Generate article audio and attach to passage', callback: () => this.generateArticleAudio() });
    this.addRibbonIcon('audio-lines', 'Google TTS: Read selection or note', () => this.read());
    this.addCommand({ id: 'read', name: 'Read selection or current note', callback: () => this.read() });
    this.addCommand({ id: 'pause-resume', name: 'Pause or resume', callback: () => this.togglePause() });
    this.addCommand({ id: 'rewind', name: 'Rewind 10 seconds', callback: () => this.seek(-10) });
    this.addCommand({ id: 'forward', name: 'Skip forward 15 seconds', callback: () => this.seek(15) });
    this.addCommand({ id: 'stop', name: 'Stop reading', callback: () => this.stop() });
    this.addCommand({ id: 'test', name: 'Test Charon with selected model', callback: () => this.speak('Google text to speech is ready. This is Charon, using your selected model.') });
    this.addSettingTab(new GoogleTTSSettings(this.app, this));
  }

  async read() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.file) { new Notice('Open a Markdown note first.'); return; }
    const selection = view.editor?.getSelection();
    const text = selection || (view.getMode() === 'source' ? view.editor.getValue() : await this.app.vault.cachedRead(view.file));
    await this.speak(text);
  }

  setControlIcon(element, icon, label) {
    setIcon(element, icon);
    element.setAttribute('aria-label', label);
    setTooltip(element, label);
  }

  iconButton(icon, label, onClick) {
    const button = this.status.createEl('button', { cls: 'clickable-icon', attr: { type: 'button' } });
    this.setControlIcon(button, icon, label);
    button.addEventListener('click', onClick);
    return button;
  }

  setPauseIcon(paused) { this.setControlIcon(this.pauseButton, paused ? 'play' : 'pause', paused ? 'Resume' : 'Pause'); }

  setStatus(text) {
    const busy = /^(Buffering|Saving|Encoding)/.test(text);
    const icon = text === 'Error' ? 'circle-alert' : text === 'Paused' ? 'pause' : text.startsWith('Playing') ? 'volume-2' : busy ? 'loader-circle' : text === 'Article audio saved' ? 'circle-check' : 'headphones';
    this.setControlIcon(this.label, icon, 'Google TTS: ' + text);
    this.label.toggleClass('is-busy', busy);
    this.label.toggleClass('is-error', text === 'Error');
  }

  async speak(markdown) {
    if (this.exporting) { new Notice('Article audio is being generated. Use Stop to cancel it first.'); return; }
    this.stop();
    const session = ++this.generation;
    const settings = { ...this.settings };
    let directory;
    let jobs = [];
    const children = new Set();
    let cancelled = false;
    const active = () => !cancelled && session === this.generation;
    try {
      const text = speechText(markdown);
      if (!text) { new Notice('There is no readable text.'); return; }
      const chunks = splitText(text, 900, settings.language);
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-google-tts-'));
      if (!active()) return;
      this.stopButton.disabled = false;
      this.setStatus(`Buffering 0/${chunks.length}`);
      const playback = { session, index: 0, pending: null, seekVersion: 0, jobs };
      this.playback = playback;
      this.rewindButton.disabled = false;
      this.forwardButton.disabled = false;
      let ready = 0;
      // Attach both handlers immediately so later failures cannot be unhandled.
      jobs = chunks.map((chunk, index) => (async () => {
        const input = path.join(directory, `text-${index}.txt`);
        const output = path.join(directory, `audio-${index}.wav`);
        await fs.writeFile(input, chunk, { mode: 0o600 });
        if (!active()) throw new Error('Cancelled');
        await this.synthesize(input, output, settings, children);
        const duration = wavDuration(await fs.readFile(output));
        ready++;
        if (active() && !this.audio) this.setStatus(`Buffering ${ready}/${chunks.length}`);
        return { output, duration };
      })().then(result => result, error => ({ error })));
      playback.jobs = jobs;
      let index = 0;
      while (index < jobs.length) {
        let offset = 0, paused = false;
        if (playback.pending) {
          ({ index, offset, paused } = playback.pending);
          playback.pending = null;
        }
        playback.index = index;
        if (!active()) return;
        if (!this.audio) this.setStatus(`Buffering ${index + 1}/${chunks.length} · ${ready} ready`);
        const result = await jobs[index];
        if (!active()) return;
        if (playback.pending) continue;
        if (result.error) throw result.error;
        const bytes = await fs.readFile(result.output);
        if (!active()) return;
        if (playback.pending) continue;
        await this.play(bytes, `${index + 1}/${chunks.length}`, offset, paused);
        if (!playback.pending) index++;
      }
      if (active()) this.setStatus('Ready');
    } catch (error) {
      if (active()) {
        this.setStatus('Error');
        new Notice('Google TTS: ' + error.message, 12000);
      }
    } finally {
      cancelled = true;
      // Wait for writers to exit before removing this session's temporary files.
      for (const child of children) child.kill('SIGTERM');
      await Promise.all(jobs);
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      if (session === this.generation) {
        this.playback = null;
        this.rewindButton.disabled = true;
        this.forwardButton.disabled = true;
        this.pauseButton.disabled = true;
        this.stopButton.disabled = true;
      }
    }
  }

  async generateArticleAudio() {
    if (this.exporting) { new Notice('Article audio is already being generated.'); return; }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) { new Notice('Open the article you want to record first.'); return; }
    const file = view.file;
    const editor = view.getMode?.() === 'preview' ? null : view.editor;
    const source = editor ? editor.getValue() : await this.app.vault.read(file).catch(error => {
      new Notice('Could not read this article: ' + error.message); return null;
    });
    if (source === null || this.exporting) return;
    const selection = editor?.getSelection();
    const start = selection ? editor.posToOffset(editor.getCursor('from')) : null;
    const text = speechText(selection || source);
    if (!text) { new Notice('There is no readable text.'); return; }
    let folder, chunks;
    try {
      folder = audioFolder(this.settings.audioFolder);
      chunks = splitText(text, 900, this.settings.language);
    } catch (error) { new Notice(error.message); return; }
    this.stop();
    const session = ++this.generation;
    const settings = { ...this.settings };
    this.exporting = true;
    this.exportButton.disabled = true;
    this.generateButton.disabled = true;
    this.stopButton.disabled = false;
    let directory, savedPath, firstError;
    let cancelled = false;
    const active = () => !cancelled && session === this.generation;
    const children = new Set();
    let jobs = [];
    try {
      // Check the local encoder before making any billed synthesis requests.
      await this.runEncoder(settings.ffmpeg, ['-version'], children);
      if (!active()) return;
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidian-article-audio-'));
      if (!active()) return;
      let completed = 0;
      this.setStatus(`Saving article audio 0/${chunks.length}`);
      jobs = chunks.map((chunk, index) => (async () => {
        const input = path.join(directory, `text-${index}.txt`);
        const output = path.join(directory, `audio-${index}.wav`);
        await fs.writeFile(input, chunk, { mode: 0o600 });
        if (!active()) throw new Error('Cancelled');
        await this.synthesize(input, output, settings, children);
        wavDuration(await fs.readFile(output));
        completed++;
        if (active()) this.setStatus(`Saving article audio ${completed}/${chunks.length}`);
        return output;
      })().then(output => ({ output }), error => {
        // Stop the other requests promptly if any chunk fails.
        firstError ||= error;
        cancelled = true;
        for (const child of children) child.kill('SIGTERM');
        return { error };
      }));
      const results = await Promise.all(jobs);
      const failed = results.find(result => result.error);
      if (failed && session === this.generation) throw firstError || failed.error;
      if (!active()) return;
      this.setStatus('Encoding article MP3');
      // Only generated ASCII filenames go into the concat manifest.
      await fs.writeFile(path.join(directory, 'parts.txt'), results.map((_, index) => `file 'audio-${index}.wav'`).join('\n'));
      const mp3 = path.join(directory, 'article.mp3');
      await this.runEncoder(settings.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', path.join(directory, 'parts.txt'), '-map', '0:a:0', '-codec:a', 'libmp3lame', '-b:a', '128k', '-ar', '24000', '-ac', '1', mp3], children);
      if (!active()) return;
      // Full decode must pass before the MP3 can be saved or attached.
      await this.runEncoder(settings.ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-i', mp3, '-f', 'null', '-'], children);
      if (!active()) return;
      const bytes = await fs.readFile(mp3);
      if (!bytes.length) throw new Error('The encoder produced an empty MP3.');
      let parent = '';
      for (const part of folder.split('/').filter(Boolean)) {
        parent = parent ? parent + '/' + part : part;
        const existing = this.app.vault.getAbstractFileByPath(parent);
        if (existing && !(existing instanceof TFolder)) throw new Error('The audio folder path points to a file.');
        if (!existing) await this.app.vault.createFolder(parent);
        if (!active()) return;
      }
      let stem = file.basename.replace(/[\[\]|#^<>:"/\\?*\x00-\x1f]/g, '-').trim() || 'Article';
      while (Buffer.byteLength(stem) > 140) stem = Array.from(stem).slice(0, -1).join('');
      const name = `${stem} - audio ${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.mp3`;
      const outputPath = folder ? folder + '/' + name : name;
      const binary = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      await this.app.vault.createBinary(outputPath, binary);
      savedPath = outputPath;
      if (!active()) { new Notice('Audio saved to ' + savedPath + '. Attachment was cancelled.'); return; }
      const insertion = passageInsertion(source, start, `![[${savedPath}]]`);
      // Prefer the original editor, including its undo history. Never use the current tab blindly.
      if (view.file === file && editor && editor.getValue() === source) {
        editor.replaceRange(insertion.text, editor.offsetToPos(insertion.offset));
      } else {
        await this.app.vault.process(file, current => {
          if (current !== source) throw new Error('The passage changed while audio was generated. Audio was saved without changing the note.');
          return current.slice(0, insertion.offset) + insertion.text + current.slice(insertion.offset);
        });
      }
      this.setStatus('Article audio saved');
      new Notice('Audio saved and attached: ' + savedPath, 12000);
    } catch (error) {
      if (session === this.generation) {
        this.setStatus('Error');
        new Notice('Google TTS: ' + error.message + (savedPath ? '\nAudio file: ' + savedPath : ''), 15000);
      }
    } finally {
      cancelled = true;
      for (const child of children) child.kill('SIGTERM');
      await Promise.all(jobs);
      if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      this.exporting = false;
      this.exportButton.disabled = false;
      this.generateButton.disabled = false;
      if (session === this.generation) this.stopButton.disabled = true;
    }
  }

  runEncoder(executable, args, children) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      children.add(child); this.children.add(child);
      let launchFailed = false, errorText = '';
      child.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-1500); });
      child.once('error', () => { launchFailed = true; });
      child.once('close', code => {
        children.delete(child); this.children.delete(child);
        if (launchFailed) reject(new Error('Could not launch FFmpeg. Check the FFmpeg path in Google TTS settings.'));
        else if (code !== 0) reject(new Error('Audio encoding or validation failed. ' + errorText));
        else resolve();
      });
    });
  }

  synthesize(input, output, settings, children) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.GEMINI_API_KEY;
      const child = spawn(settings.python, [...(settings.helper ? [settings.helper] : ['-c', BUNDLED_HELPER]), 'synthesize',
        '--input-file', input, '--language-code', settings.language,
        '--model-name', settings.model, '--voice', 'Charon', '--encoding', 'LINEAR16',
        '--sample-rate-hertz', '24000', '--output', output], { env, stdio: ['ignore', 'ignore', 'pipe'] });
      children.add(child);
      this.children.add(child);
      let errorText = '';
      let launchFailed = false;
      child.stderr.on('data', data => { errorText = (errorText + data.toString()).slice(-3000); });
      child.once('error', () => { launchFailed = true; });
      child.once('close', code => {
        children.delete(child);
        this.children.delete(child);
        if (launchFailed) reject(new Error('Could not launch the Google TTS helper. Check its path in settings.'));
        else if (code === 0) resolve();
        else {
          let message = 'Synthesis failed. Check your Google TTS login and quota.';
          if (/invalid_grant/i.test(errorText)) message = 'Your Google login needs reconnecting.';
          else if (/429|RESOURCE_EXHAUSTED|quota/i.test(errorText)) message = 'Google TTS quota was reached. Try again later.';
          else if (/403|PERMISSION_DENIED/i.test(errorText)) message = 'Google denied access to this TTS model.';
          reject(new Error(message));
        }
      });
    });
  }

  play(bytes, position, offset = 0, paused = false) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const audio = new Audio(url);
      let finished = false;
      const finish = error => {
        if (finished) return;
        finished = true;
        audio.pause();
        audio.removeAttribute('src');
        URL.revokeObjectURL(url);
        if (this.audio === audio) { this.audio = null; this.finishAudio = null; }
        error ? reject(error) : resolve();
      };
      this.audio = audio;
      this.finishAudio = () => finish();
      this.playingPosition = position;
      this.pauseButton.disabled = false;
      this.setPauseIcon(false);
      this.setStatus('Playing ' + position);
      audio.onloadedmetadata = () => {
        if (offset) audio.currentTime = Math.min(offset, audio.duration);
      };
      audio.onended = () => finish();
      audio.onerror = () => finish(new Error('Audio playback failed.'));
      if (paused) {
        this.setPauseIcon(true);
        this.setStatus('Paused');
      } else audio.play().catch(() => finish(new Error('Audio playback could not start.')));
    });
  }

  async seek(seconds) {
    const playback = this.playback;
    if (!playback) return;
    const version = ++playback.seekVersion;
    let index = playback.pending?.index ?? playback.index;
    let offset = (playback.pending?.offset ?? this.audio?.currentTime ?? 0) + seconds;
    const paused = playback.pending?.paused ?? (this.audio ? this.audio.paused : false);
    try {
      while (offset < 0 && index > 0) {
        const previous = await playback.jobs[--index];
        if (previous.error) throw previous.error;
        offset += previous.duration;
      }
      offset = Math.max(0, offset);
      while (true) {
        const target = await playback.jobs[index];
        if (target.error) throw target.error;
        if (offset < target.duration || index === playback.jobs.length - 1) {
          offset = Math.min(offset, Math.max(0, target.duration - 0.01));
          break;
        }
        offset -= target.duration;
        index++;
      }
      if (this.playback !== playback || version !== playback.seekVersion) return;
      playback.pending = { index, offset, paused };
      if (this.finishAudio) this.finishAudio();
    } catch (error) {
      if (this.playback === playback && version === playback.seekVersion) {
        new Notice('Google TTS: Could not seek. ' + error.message);
      }
    }
  }

  togglePause() {
    if (!this.audio) return;
    if (this.audio.paused) {
      this.audio.play().then(() => {
        this.setPauseIcon(false); this.setStatus('Playing ' + this.playingPosition);
      }).catch(() => new Notice('Could not resume audio.'));
    } else {
      this.audio.pause(); this.setPauseIcon(true); this.setStatus('Paused');
    }
  }

  stop() {
    this.generation++;
    this.playback = null;
    this.rewindButton.disabled = true;
    this.forwardButton.disabled = true;
    for (const child of this.children) child.kill('SIGTERM');
    if (this.finishAudio) this.finishAudio();
    this.pauseButton.disabled = true;
    this.setPauseIcon(false);
    this.stopButton.disabled = true;
    this.setStatus('Ready');
  }

  onunload() { this.stop(); }
}

class GoogleTTSSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Google TTS' });
    containerEl.createEl('p', { text: 'Charon with your selected Gemini TTS model. Uses your local Google Cloud credentials. Requires Python 3.10 or newer. Google may charge for synthesis. Only text you choose to read or export is sent to Google. Read-aloud audio is temporary. Save audio creates a permanent MP3 and embeds it in your note.' });
    new Setting(containerEl).setName('Model').setDesc('Flash models favor fast startup. Changes apply to the next reading.').addDropdown(drop => {
      for (const [id, label] of Object.entries(MODELS)) drop.addOption(id, label);
      drop.setValue(this.plugin.settings.model).onChange(async value => {
        this.plugin.settings.model = value; await this.plugin.saveData(this.plugin.settings);
      });
    });
    containerEl.createEl('p', { text: 'The first two chunks contain one sentence each. All chunks are requested together and play in order as audio becomes available. Long notes may reach your Google quota. Markdown formatting is removed before reading.' });
    new Setting(containerEl).setName('Language').addDropdown(drop => drop
      .addOption('en-US', 'English').addOption('pt-BR', 'Português brasileiro')
      .setValue(this.plugin.settings.language).onChange(async value => {
        this.plugin.settings.language = value; await this.plugin.saveData(this.plugin.settings);
      }));
    let folderInput;
    new Setting(containerEl).setName('Article audio folder')
      .setDesc('Folder inside this vault. New folders are created when saving. Leave empty to use the vault root.')
      .addText(input => {
        folderInput = input;
        input.setPlaceholder('Audio').setValue(this.plugin.settings.audioFolder).onChange(async value => {
          this.plugin.settings.audioFolder = value; await this.plugin.saveData(this.plugin.settings);
        });
      })
      .addButton(button => button.setButtonText('Choose folder').onClick(() => {
        new AudioFolderPicker(this.app, async folder => {
          folderInput.setValue(folder); this.plugin.settings.audioFolder = folder;
          await this.plugin.saveData(this.plugin.settings);
        }).open();
      }));
    new Setting(containerEl).setName('Python path').setDesc('Python 3.10 or newer. Use an absolute executable path if Python is not available to Obsidian.').addText(input => input.setValue(this.plugin.settings.python).onChange(async value => { this.plugin.settings.python = value.trim(); await this.plugin.saveData(this.plugin.settings); }));
    new Setting(containerEl).setName('FFmpeg path').setDesc('Used to assemble and validate the article MP3.')
      .addText(input => input.setValue(this.plugin.settings.ffmpeg).onChange(async value => {
        this.plugin.settings.ffmpeg = value.trim(); await this.plugin.saveData(this.plugin.settings);
      }));
    new Setting(containerEl).setName('Article audio').setDesc('Record the selection or whole note, save an MP3, and attach a player above the passage. Publish the MP3 along with the article for online playback.')
      .addButton(button => button.setButtonText('Generate and attach audio').onClick(() => this.plugin.generateArticleAudio()));
    new Setting(containerEl).setName('Test voice').setDesc('Generate and play a short Charon sample.').addButton(button => button.setButtonText('Test Charon').onClick(() => this.app.commands.executeCommandById('dom-google-tts:test')));
  }
}

module.exports = GoogleTTS;
module.exports.splitText = splitText;

module.exports.speechText = speechText;

module.exports.wavDuration = wavDuration;

module.exports.audioFolder = audioFolder;
module.exports.passageInsertion = passageInsertion;
