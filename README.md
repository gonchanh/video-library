# Video library

A user-invoked Pi skill for TV episodes, flat movie libraries and Jellyfin metadata. Processing preserves the source container unless you request a change.

## Install

Install [Bun](https://bun.sh/docs/installation) with `bun check` support, [BAML](https://boundaryml.com/quickstart), FFmpeg with FFprobe, and [Jellyfin Server](https://jellyfin.org/docs/general/installation/). Put their executables on PATH. Linux also needs GNU coreutils, util-linux and iproute2. Windows needs PowerShell 5.1; set `JELLYFIN_BIN` if `jellyfin.exe` is not on PATH.

```sh
git clone https://github.com/gonchanh/video-library.git "$HOME/.pi/agent/skills/video-library"
cd "$HOME/.pi/agent/skills/video-library"
bun run doctor
```

Doctor installs and updates project dependencies, generates BAML code and runs the full verification. Its Jellyfin test uses temporary data and its own HTTP port, not your configured service or libraries. Missing tools fail with installation guidance.

Start or reload Pi, then invoke `/skill:video-library`.

## Metadata credentials

Copy `.env.example` to `.env` and fill `api_read_access_token` or `api_key` with your TMDB credentials. Doctor tests access without printing credentials. Keep `.env` private.

Metadata can be wrong or incomplete. Without API access, IMDb is the default movie reference and metadata needs manual review.

Windows is a source-reviewed preview, not tested on a Windows machine. Automatic deletion of originals is disabled there.
