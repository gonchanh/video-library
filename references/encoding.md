# Lossy encoding

Read this only when the user asks to reduce storage or change video codecs. The default proposal is remuxing without re-encoding.

Already-compressed videos rarely shrink through ZIP or 7z. FFV1 is lossless video encoding but usually much larger. AV1 and HEVC can save space by changing the picture. Call that lossy, even when the result looks similar.

1. Inventory codecs, resolution, bit depth, HDR/color metadata, subtitles, audio and available space. Start with older inefficient encodes; leave existing HEVC or AV1 alone unless measurements justify another generation of loss.
2. Ask about playback devices. Confirm they support the chosen codec, bit depth and container. Propose software encoding for size/quality or hardware encoding for speed with that trade-off stated.
3. Present a sample-encoding plan with source clips, output paths, encoder settings and source retention. Stop for explicit user approval before creating samples. After approval, encode representative motion, dark scenes, grain and animation at several quality settings. Compare visually at the intended display size. Preserve resolution, frame rate, HDR/color metadata, audio, subtitles and chapters. Copy audio and subtitle streams unless a compatibility change is approved.
4. Record the selected codec, encoder, preset and quality setting in a run-specific script. Software x265 `slow` at CRF 21 or SVT-AV1 preset 5 at CRF 30 are sample starting points, not quality guarantees or approved defaults.
5. Present the sample results and the full batch plan. Stop for explicit user approval of that plan before batch encoding. Approval to create samples does not authorize the batch. Keep originals and budget enough space for both copies. Use temporary outputs, no-overwrite publication, hashes, structural checks and full decode, as in the remux workflow. The bundled remux scripts do not execute lossy profiles; extend and test them for that run rather than editing a remux plan to smuggle encoder options into it.

A successful decode checks corruption, not whether the encode looks good. Delete originals only if the approved plan explicitly includes deletion and the user has approved playback and the retention or backup decision.
