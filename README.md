# Google TTS

Read a note or selection aloud with Google text-to-speech, or save a complete MP3 and embed it in the note. Includes pause, stop, rewind, forward, model selection, and English and Brazilian Portuguese settings.

Desktop only. This release has automated tests on macOS; it has not been tested on Windows or Linux. Python 3.10 or newer is required. FFmpeg is required for MP3 export. The Python speech client is bundled inside main.js, so no Codex installation is needed.

## Install from GitHub

[Download Google TTS 1.4.0](https://github.com/TheDominator54/obsidian-google-tts/releases/download/1.4.0/dom-google-tts-1.4.0.zip). Unzip it and move the `dom-google-tts` folder into your vault's `.obsidian/plugins/` folder. Reload Obsidian and enable Google TTS in Community plugins. You still need the local tools and Google authentication described below.

## Setup

1. Install Python 3.10 or newer and FFmpeg. On an Apple Silicon Mac with Homebrew, use `brew install python ffmpeg`.
2. Set up your own Google Cloud project, enable Cloud Text-to-Speech, and configure billing if required. Google charges depend on the selected model and your account.
3. Install the Google Cloud CLI and run `gcloud auth application-default login`. Configure your project's quota billing with `gcloud auth application-default set-quota-project YOUR_PROJECT_ID`. Authentication files stay outside your vault. The plugin also supports an existing Google TTS helper credential file or GOOGLE_APPLICATION_CREDENTIALS inherited by Obsidian.
4. Install and enable this plugin. In its settings, set absolute Python and FFmpeg executable paths if automatic defaults do not work. Select your language and model.
5. Use the Test voice button, or the commands to read a note, read a selection, or generate article audio.

For manual installation, copy main.js, manifest.json, and styles.css into `.obsidian/plugins/dom-google-tts/` in your vault, then reload Obsidian and enable Google TTS.

## Privacy

Only text you explicitly ask to read or export is sent to Google for synthesis, with your Google authentication and billing project. Audio requests may run concurrently. Google processes that text under its own terms and privacy policies. There is no developer-operated server or analytics.

Playback uses temporary local files that the plugin removes when the operation finishes. Exported MP3s remain in the vault until you delete them. A crash may leave temporary files. Local Google credentials are read to authorize requests; they are not bundled with the plugin or stored in the vault by this plugin. Do not publish your credentials or plugin settings containing private paths.

Saving audio inserts an embedded player in your note. Publish the audio file alongside the note if you want it available online. Only use text you have permission to send to Google and publish.

## Development

Run `node --test main.test.cjs portable.test.cjs`. The export tests use FFmpeg. The portability test expects Homebrew Python on macOS. Automated tests do not establish live Obsidian UI or Google synthesis acceptance.

The complete readable Python client is embedded as a string near the top of main.js. It runs locally as a Python subprocess; no remote code is downloaded or executed.
