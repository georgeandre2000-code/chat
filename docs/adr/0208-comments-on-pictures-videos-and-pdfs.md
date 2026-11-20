# 0208. Comments on pictures, videos and PDFs: the file's conversation, with pins

- Status: Accepted (built)
- Date: 2026-11-20
- Extends: 0199 (a live file's conversation), 0196 §8 (a live file's pictures), 0157 (who sees a file), 0040 and 0054
  (the judge's `box` on an image)
- Code: engine `packages/engine/src/live/media.ts` (`mediaOfType`, `mediaKindOf`, `talkKindOf`), `live/conversation.ts`
  (`ensureFileConversation`, `openFileConversation`, `cleanSelection`, `isPinned`, `markWords`, `liveRefLine`,
  `fileConversationBrief`), `live/assets.ts` (`putMarkPicture`, `getAsset`), `artifacts.ts` (`mediaFileOf`),
  `live/resolve.ts` (`resolveComment`, `resolvedOf`), `live/comment-tools.ts` (`createCommentToolSource`,
  `isMediaConversation`), `events.ts` (`message.resolved`), `executor.ts` (the Drive's tools in such a conversation),
  `tools/directory.ts` (`LIVE_FILE_TOOLS`); server `routes/app/live.ts` (`POST …/artifacts/{id}/marks`,
  `POST …/messages/{id}/resolve`), `routes/app/schemas.ts` (`LiveSelection`); client `live/types.ts` (`TalkKind`,
  `FileMediaKind`, `isTalkKind`, `isPinnedSelection`, `resolvedOf`), `live/api.ts` (`uploadMark`, `resolveComment`),
  `api/queries.ts` (`cacheResolved`, `useResolveComment`), `lib/files.ts` (`mediaKindOfType`, `mediaKindOfArtifact`);
  web `components/live/media/*` (`FilePage`, `MediaFilePage`, `ImageStage`, `VideoStage`, `PdfStage`, `MediaPins`,
  `marks.ts`, `ResolveBits`, `ViewerBits`), `components/live/talk.ts`, `TalkBits.tsx`, `pages/ChannelPage.tsx`,
  `components/artifacts/ArtifactViewer.tsx`, `FileView.tsx`, `ImageZoom.tsx` (`overlay`), `packages/ui`
  `VideoPlayer.tsx` (`onTime`, `onVideo`, `marks`); phone `features/files/ImageViewer.tsx`, `ZoomPicture.tsx`,
  `DocumentViewer.tsx`, `features/live-files/talk/*` (`PicturePins`, `logic.ts`), `features/chat/sheets.tsx`

## Context

A picture, a video or a PDF posted in a conversation or kept in the Drive opened only in the viewer: people talked
about it in the channel, out of sight of the file, and had no way to say "here". Live files already have a
conversation of their own beside them, with a canvas comment pinned where it points (ADR 0199). People want the same
on what they upload, the way a design tool or a spreadsheet keeps comments on the file: a pin on the place, the
people and the agents answering beside it, and the comment closed once handled. An agent asked about a place has to
see that place, and no model here watches a video (`file-reader.ts`).

## Decision

### 1. One conversation per file, a comment is one of its messages

A `file` artifact whose current version is a picture (PNG, JPEG, GIF, WebP), a video (MP4, WebM, QuickTime) or a PDF
(`mediaOfType`, the list the apps preview) gets the file conversation of ADR 0199 unchanged: its own `file` channel
and hidden root, made on first use, read by whoever reads the file, agents admitted the same way. Its root and its
messages' `liveRef` name what it is (`kind` `image`, `video` or `pdf`, the conversation's `TalkKind`) rather than the
artifact's kind. Any other upload still has none (`artifact.no_conversation`).

A comment is a message of that conversation whose `meta.liveRef.selection` points at a place (`isPinned`):

- `mark`: a point (`x`, `y`) or an area (`x`, `y`, `w`, `h`), in fractions of the picture, of the video's frame or
  of the PDF's page, rounded to a ten-thousandth, an area kept inside the picture;
- `time`: a video's moment, in seconds; `page`: a PDF's page, from 1;
- `version`: the file's version it was made on (a newer version shows the older pins faded);
- `crop`, `frame`: the app's two pictures of the place (§2);
- `label`: its pin's number as the app wrote it.

There is no thread per pin: the conversation reads as one, pins number its comments oldest first (the apps and the
agents count the same way), and a message that names no place is about the file as a whole. One model for live files
and uploads, nothing new to store but the pictures.

### 2. The app's pictures of the place

What the person sees is the only picture of a video's moment or of a drawn PDF page, and a crop reads better than a
whole picture with coordinates. So the web app takes two small JPEGs when a place is marked: the crop of the area (or
of a window around a point), at most 800 pixels wide, and the whole picture, frame or page with the mark drawn, at
most 1024. They go up only with the message (`prepareAbout`, the send waits at most 8 s and goes without them past
it), to `POST …/artifacts/{id}/marks`: a reader of the file stores them as the file's pictures (`live_assets`, source
`mark`, PNG, JPEG or WebP by its bytes, at most 2 MB, counted in the workspace's storage, purged with the file), and
the message names them. They are served like a live file's pictures (`GET …/assets/{assetId}`) to whoever reads the
file, and the conversation's line shows the crop as a thumbnail. The phone sends none: its comments carry the place
alone.

### 3. Resolved

`POST …/messages/{id}/resolve` (`resolved` true or false), by whoever writes in the conversation, and the agent's
`resolve_comment`, set or clear `meta.resolved` (`by`, `at`) on a comment with a pin; anything else is
`message.not_comment`. The message stays where it is with "Resolved by … · time" under it; its pin leaves the file
until "N resolved" shows them again, faded. Everyone in the conversation gets `message.resolved`. Resolving twice
keeps the first.

### 4. What the agent sees and does

A run in such a conversation gets the file's brief (what it is, that comments point at places, the tools below) and
the Drive's tools as well as the `files` group, so it reads the picture or the PDF with `read_artifact`. Under each
comment its line says where it points in words (`markWords`: page, moment, the area in percentages, the version) and
names its pictures. Three tools, listed only there (`createCommentToolSource`, behind the channel's cached kind):

- `look_at_comment`: the comment's two pictures, where it points and its words (as outside text), by its number or
  the id its line gives;
- `comment_on_file`: the agent's own comment with a pin, posted as its answer (like a GIF, an empty reply after it
  posts nothing); on a picture a `target` in words is placed by the judge's `box` (Jev), else the agent gives `x`,
  `y` (and `w`, `h`), on a video a `time`, on a PDF a `page`;
- `resolve_comment`: by its number.

### 5. The apps

On the web the preview comes first: a picture, a video or a PDF opened from the chat or the Drive opens in the viewer
as before, now with its open comments' pins over the picture (their words on hover) and "Comment" and "Conversation
N" over it; a pin, or either button, opens the file's page (`/drive/<id>`, `?m=` at a comment, `?comment` with Comment
on). Under a file with comments the chat shows their line (who, how many, when), the thread line's look.

The page is a live file's (ADR 0199 §6): the header without what only a live file has, the conversation docked
beside it, the file on a quiet stage, the canvas's dock (Move, Comment, ask the file's agent) and its zoom island.
With Comment on, a click marks a point and a drag an area; the conversation opens with "About area 4 of the image"
and the crop over its composer. A video plays in our player with its comments as marks over the timeline; Comment
pauses it and marks that moment (and a point or an area of the frame). A PDF is drawn by pdf.js (Apache-2.0, loaded
only on that page), a page read and drawn as it comes near and let go when it goes far; a comment marks a page and a
point or an area of it.

The phone follows its live files: the viewer pins a picture's open comments on it and ends with the file's talk line;
its Comment marks a point on a picture or the moment a video is paused at and opens the conversation with it; a PDF
has the talk line. Resolve and Reopen are in the message's menu.

## Consequences

- Uploads and live files share one conversation model, one `liveRef` and one set of screens; the selection grows by
  six optional fields.
- Comments made on the web carry two small pictures each, stored with the file; a comment dropped before it is sent
  stores nothing.
- The web app gains pdf.js, out of its first load (about 136 KB, and its worker about 379 KB, compressed, once).
- A video's comment is as good as the frame the person marked: the agent still never watches the video.
- Phone comments carry no pictures and no areas; their agents read the file itself.
