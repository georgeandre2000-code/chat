import type { ArtifactDetail, FileMediaKind, LiveSelection } from "@agenteschat/client";
import { ApiError, keys, useApi, useArtifact, useFileConversation, useThreadMessages } from "@agenteschat/client";
import { errorText } from "@agenteschat/client/lib/errors";
import { agentGrammar } from "@agenteschat/client/lib/grammar";
import {
  Button,
  cx,
  EmptyState,
  Icon,
  Menu,
  MenuItem,
  MenuSeparator,
  typingInField,
  useMatchMedia,
} from "@agenteschat/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentAvatar } from "@/components/AgentAvatar";
import { useArtifactDownload, useDeleteArtifact } from "@/components/artifacts/ArtifactActions";
import { usePreviewUrl } from "@/components/artifacts/FileView";
import { useFileShare } from "@/components/artifacts/ShareDialog";
import { useOrg } from "@/components/org-context";
import { useDocumentTitle } from "@/lib/desktop";
import type { LiveAskRequest } from "../editor";
import {
  FileConversationButton,
  FileConversationPanel,
  LIVE_TALK_DOCKED,
  useFileAgent,
  useFileTalkColumn,
  useFileTalkLive,
} from "../FileConversation";
import { LIVE_COMPACT_QUERY, type LiveFileSearch } from "../LiveFilePage";
import { LiveCrumbs, LiveMeta } from "../LiveHeader";
import { usePageRoom } from "../room";
import { talkIcon } from "../TalkBits";
import { FileAgentContext, type FileTalk, FileTalkContext, LiveAskContext, takeRevealOnOpen } from "../talk";
import { ImageStage, type MediaTool, type StageMarks } from "./ImageStage";
import { type Mark, type MarkPictures, mediaPinsOf, takeMarkPictures } from "./marks";
import { PdfStage } from "./PdfStage";
import { type VideoHandle, VideoStage } from "./VideoStage";
import "../live.css";
import "../canvas/canvas.css";
import "./media.css";

const ZOOM_STEPS = [1, 1.5, 2, 3, 4];

/** A comment being written: what it points at, the app's pictures of the place (sent with it), and its own key. */
interface Draft {
  selection: LiveSelection;
  thumb: string | null;
  pictures: MarkPictures | null;
  key: number;
}

/** A message waits at most this long for its pictures to go up; past it, it goes without them. */
const PICTURES_WAIT_MS = 8_000;

/**
 * A picture, a video or a PDF on a page of the app with its conversation beside it (ADR 0208), as a live file's page
 * is (ADR 0199): the header (where it is, Share, the conversation's toggle, ⋯, the title, who made it), the file in
 * the middle with its comments pinned on it (numbered, with who wrote them), and under it the tools: Move, Comment
 * (a click marks a point, a drag an area; on a video, at that moment; on a PDF, on that page) and asking the file's
 * agent. A comment goes in the conversation's composer as "About area 4 of the image", with the app's picture of the
 * place, and rides on the next message; Resolved takes its pin off the file until "Show resolved".
 */
export function MediaFilePage({
  fileId,
  media,
  search,
  onSearch,
}: {
  fileId: string;
  media: FileMediaKind;
  search: LiveFileSearch;
  onSearch: (patch: Partial<LiveFileSearch>) => void;
}) {
  const { t, i18n } = useTranslation();
  const { org } = useOrg();
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const compact = useMatchMedia(LIVE_COMPACT_QUERY);
  const wide = useMatchMedia(LIVE_TALK_DOCKED);
  const query = useArtifact(org.id, fileId);
  const artifact = query.data;
  const content = artifact?.content.kind === "file" ? artifact.content : null;
  const version = artifact?.version ?? 1;
  useDocumentTitle(artifact?.title);
  const share = useFileShare();
  const downloads = useArtifactDownload();
  const remover = useDeleteArtifact(() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } }));
  const [pageEl, setPageEl] = useState<HTMLDivElement | null>(null);

  // ── The conversation (ADR 0199) ─────────────────────────────────────────────────────────────────────────────
  const column = useFileTalkColumn(artifact);
  const talkOpen = column.open && Boolean(artifact);
  const docked = talkOpen && wide;
  const pageRoom = usePageRoom(pageEl, docked);
  const folded = compact || pageRoom.narrow;
  const at = useFileConversation(org.id, artifact ?? { id: fileId, conversation: null }, talkOpen);
  const fileAgent = useFileAgent(artifact);
  const talkRef = artifact?.conversation ?? at ?? null;
  useFileTalkLive(fileId, talkRef?.channelId);
  const messages = useThreadMessages(org.id, talkRef?.channelId, talkRef?.rootId ?? "");
  // With the conversation closed nothing else reads it: a new message there (the count moves) reads it again.
  const counted = useRef(artifact?.conversation?.count);
  useEffect(() => {
    const talk = artifact?.conversation;
    if (!talk || counted.current === talk.count) return;
    counted.current = talk.count;
    void qc.invalidateQueries({ queryKey: keys.thread(org.id, talk.channelId, talk.rootId), exact: true });
  }, [qc, org.id, artifact?.conversation]);
  const pins = useMemo(() => mediaPinsOf(messages.data ?? [], fileId, version), [messages.data, fileId, version]);

  const [tool, setTool] = useState<MediaTool>(search.comment ? "comment" : "move");
  const [zoom, setZoom] = useState(1);
  const [showResolved, setShowResolved] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(search.m ?? null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftPage, setDraftPage] = useState<number | undefined>(undefined);
  const [pageNow, setPageNow] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [prefill, setPrefill] = useState<{ text: string; key: number } | null>(null);
  const video = useRef<VideoHandle | null>(null);

  // A link or a notice named one of its messages: the conversation opens there, its pin shown.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per message named; the column's state is read then
  useEffect(() => {
    if (!search.m) return;
    setFocusId(search.m);
    if (!column.open) column.toggle();
  }, [search.m]);
  const closeTalk = () => (column.sheet ? column.closeSheet() : column.toggle());

  // The draft's picture goes with it.
  useEffect(() => {
    const thumb = draft?.thumb;
    return () => {
      if (thumb) URL.revokeObjectURL(thumb);
    };
  }, [draft?.thumb]);

  /** A pin was pressed: the conversation opens at its message, and a video goes to its moment. */
  const openPin = useCallback(
    (messageId: string) => {
      setFocusId(messageId);
      const pin = pins.find((p) => p.message.id === messageId);
      if (pin?.selection.time !== undefined) video.current?.seek(pin.selection.time);
      if (!column.open) column.toggle();
      // The same one again re-sets the address, so the conversation scrolls to it again.
      onSearch({ m: undefined });
      requestAnimationFrame(() => onSearch({ m: messageId }));
    },
    [pins, column, onSearch],
  );

  /** A message's line about this file: its pin, its moment, its page. */
  const reveal = useCallback(
    (part: LiveSelection) => {
      const pin = pins.find(
        (p) =>
          (part.crop && p.selection.crop === part.crop) ||
          (JSON.stringify(p.selection.mark) === JSON.stringify(part.mark) &&
            p.selection.time === part.time &&
            p.selection.page === part.page),
      );
      if (pin) setFocusId(pin.message.id);
      if (part.time !== undefined) {
        video.current?.pause();
        video.current?.seek(part.time);
      }
    },
    [pins],
  );
  // A message's line elsewhere opened this file at part of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once the comments are read
  useEffect(() => {
    if (!messages.data) return;
    const waiting = takeRevealOnOpen(fileId);
    if (waiting) reveal(waiting);
  }, [fileId, Boolean(messages.data)]);

  /** "Ask Iris": the conversation opens with the agent's @. */
  const ask = useCallback(
    (request: LiveAskRequest = {}) => {
      const agent = request.agentId === null ? null : fileAgent;
      const words = [agent ? `@${agent.handle}` : "", request.text?.trim() ?? ""].filter(Boolean).join(" ");
      if (words) setPrefill({ text: `${words} `, key: Date.now() });
      if (!column.open) column.toggle();
    },
    [fileAgent, column],
  );

  /**
   * A mark made with Comment: the composer gets it at once ("About area 4 of the image") with the app's two pictures
   * of the place, which go up only with the message (`prepareAbout`): a comment dropped stores nothing.
   */
  const comment = useCallback(
    async (
      mark: Mark | null,
      picture: { source: CanvasImageSource; width: number; height: number } | null,
      extra: { time?: number; page?: number },
    ) => {
      setTool("move");
      const key = Date.now();
      const selection: LiveSelection = {
        label: String(pins.length + 1),
        ...(mark ? { mark } : {}),
        ...extra,
        version,
      };
      setDraft({ selection, thumb: null, pictures: null, key });
      setDraftPage(extra.page);
      setFocusId(null);
      if (!column.open) column.toggle();
      if (!mark || !picture) return;
      const pictures = await takeMarkPictures(picture.source, picture.width, picture.height, mark);
      if (!pictures) return;
      const thumb = URL.createObjectURL(pictures.crop);
      setDraft((d) => (d?.key === key ? { ...d, thumb, pictures } : d));
    },
    [pins.length, version, column],
  );

  // The draft as the send reads it (the conversation calls `prepareAbout` as the message goes).
  const draftNow = useRef<Draft | null>(null);
  draftNow.current = draft;
  /** The comment's pictures go up as its message goes; it goes without them when they can't (the agent reads the file). */
  const prepareAbout = useCallback(
    async (about: LiveSelection): Promise<LiveSelection> => {
      const pictures = draftNow.current?.pictures;
      if (!pictures || about.crop) return about;
      const upload = Promise.all([
        api.live.uploadMark(org.id, fileId, pictures.crop),
        api.live.uploadMark(org.id, fileId, pictures.frame),
      ]).then(([crop, frame]) => ({ ...about, crop: crop.id, frame: frame.id }));
      const late = new Promise<LiveSelection>((resolve) => setTimeout(() => resolve(about), PICTURES_WAIT_MS));
      return Promise.race([upload, late]).catch(() => about);
    },
    [api, org.id, fileId],
  );

  // C turns Comment on, H back to moving, Esc leaves Comment (outside a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typingInField(e.target)) return;
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const k = e.key.toLowerCase();
      if (k === "c") setTool((was) => (was === "comment" ? "move" : "comment"));
      else if (k === "h") setTool("move");
      else if (k === "escape" && tool === "comment") setTool("move");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tool]);

  const talk = useMemo<FileTalk | null>(
    () =>
      artifact
        ? {
            artifactId: artifact.id,
            kind: media,
            title: artifact.title,
            rootId: talkRef?.rootId ?? null,
            about: draft?.selection ?? null,
            aboutThumb: draft?.thumb ?? null,
            dropAbout: () => {
              setDraft(null);
              setDraftPage(undefined);
            },
            prepareAbout,
            prefill,
            tookPrefill: () => setPrefill(null),
            reveal,
          }
        : null,
    [artifact, media, talkRef?.rootId, draft, prefill, reveal, prepareAbout],
  );

  const image = media === "image";
  const preview = usePreviewUrl(fileId, version, content?.contentType ?? "", Boolean(content) && image);
  const fileUrl = api.artifacts.fileUrl(org.id, fileId, { version });

  const notFound =
    query.isError && query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 403);
  if (notFound || query.isError) {
    return (
      <div className="lf-page lf-page--empty">
        <EmptyState
          size="page"
          icon={notFound ? "file" : "alert"}
          title={notFound ? t("live.shell.notFound.title") : t("live.shell.failed.title")}
          actions={
            notFound ? (
              <Button
                variant="primary"
                onClick={() => void navigate({ to: "/org/$orgId/drive", params: { orgId: org.id } })}
              >
                {t("live.shell.notFound.back")}
              </Button>
            ) : (
              <Button onClick={() => void query.refetch()}>{t("live.shell.failed.retry")}</Button>
            )
          }
        >
          {notFound ? null : errorText(t, query.error, i18n.language)}
        </EmptyState>
      </div>
    );
  }

  const marks: StageMarks = {
    pins,
    focusId,
    showResolved,
    draft: draft?.selection.mark
      ? { mark: draft.selection.mark, n: Number(draft.selection.label) || pins.length + 1 }
      : null,
    draftPage,
    tool,
    onOpenPin: openPin,
  };
  const resolvedCount = pins.filter((p) => p.resolved).length;
  const maxZoom = media === "pdf" ? 3 : (ZOOM_STEPS[ZOOM_STEPS.length - 1] ?? 4);
  const step = (dir: 1 | -1) =>
    setZoom((z) => {
      const steps = media === "pdf" ? [0.75, 1, 1.25, 1.5, 2, 3] : ZOOM_STEPS;
      const i = steps.findIndex((s) => s >= z - 1e-6);
      const next = steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? steps.length - 1 : i) + dir))] ?? 1;
      return Math.min(maxZoom, next);
    });

  let stage: ReactNode = null;
  if (!artifact || !content) stage = <div className="mf-stage mf-stage--loading" aria-busy="true" />;
  else if (media === "image") {
    stage = preview.url ? (
      <ImageStage
        src={preview.url}
        width={content.width}
        height={content.height}
        zoom={zoom}
        marks={marks}
        alt={artifact.title}
        onMark={(mark, el) => void comment(mark, { source: el, width: el.naturalWidth, height: el.naturalHeight }, {})}
      />
    ) : preview.failed ? (
      <EmptyState size="panel" icon="image" title={t("files.comments.loadFailed")} />
    ) : (
      <div className="mf-stage mf-stage--loading" aria-busy="true" />
    );
  } else if (media === "video") {
    stage = (
      <VideoStage
        src={fileUrl}
        name={content.name}
        marks={marks}
        onHandle={(h) => {
          video.current = h;
        }}
        onMark={(mark, time, el) =>
          void comment(
            mark,
            { source: el, width: el.videoWidth, height: el.videoHeight },
            { time: Math.round(time * 10) / 10 },
          )
        }
      />
    );
  } else {
    stage = (
      <PdfStage
        src={fileUrl}
        zoom={zoom}
        marks={marks}
        onPages={setPageCount}
        onPage={setPageNow}
        onMark={(mark, page, canvas) =>
          void comment(mark, { source: canvas, width: canvas.width, height: canvas.height }, { page })
        }
      />
    );
  }

  const askLabel = fileAgent ? t("live.conversation.ask", agentGrammar(fileAgent.name)) : "";
  const percent = new Intl.NumberFormat(i18n.language, { style: "percent" }).format(zoom);
  return (
    <FileTalkContext.Provider value={talk}>
      <FileAgentContext.Provider value={fileAgent}>
        <LiveAskContext.Provider value={ask}>
          <div
            ref={setPageEl}
            className="lf-page mf-root"
            data-kind={media}
            data-compact={folded || undefined}
            data-talk={docked || undefined}
          >
            <MediaHeader
              artifact={artifact ?? null}
              media={media}
              compact={folded}
              talk={
                artifact ? (
                  <FileConversationButton
                    artifact={artifact}
                    open={talkOpen}
                    compact={folded}
                    onToggle={column.toggle}
                  />
                ) : null
              }
              onShare={() => artifact && share.open(artifact)}
              onCopyLink={() => artifact && share.copyLink(artifact)}
              onDownload={() => artifact && void downloads.save(artifact)}
              onDelete={() => artifact && remover.ask(artifact)}
            />
            <div className="lf-body">
              <div className="lf-stage mf-body">
                {stage}
                {media !== "video" && (
                  <div className="cnv-zoom ac-glass mf-zoom" role="toolbar" aria-label={t("live.canvas.zoom.label")}>
                    {resolvedCount > 0 && (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={showResolved ? "eye" : "eyeOff"}
                          aria-pressed={showResolved}
                          title={t(showResolved ? "files.comments.hideResolved" : "files.comments.showResolved")}
                          onClick={() => setShowResolved((v) => !v)}
                        >
                          {t("files.comments.resolvedCount", { count: resolvedCount })}
                        </Button>
                        <span className="cnv-bar__divider" aria-hidden="true" />
                      </>
                    )}
                    {media === "pdf" && pageCount > 0 && (
                      <>
                        <span className="mf-pages-now tabular">
                          {t("files.comments.pageOf", { page: pageNow, count: pageCount })}
                        </span>
                        <span className="cnv-bar__divider" aria-hidden="true" />
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon="dash"
                      aria-label={t("live.canvas.zoom.out")}
                      title={t("live.canvas.zoom.out")}
                      disabled={zoom <= (media === "pdf" ? 0.75 : 1)}
                      onClick={() => step(-1)}
                    />
                    <Button size="sm" variant="ghost" className="cnv-zoom__level tabular" onClick={() => setZoom(1)}>
                      {percent}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon="plus"
                      aria-label={t("live.canvas.zoom.in")}
                      title={t("live.canvas.zoom.in")}
                      disabled={zoom >= maxZoom}
                      onClick={() => step(1)}
                    />
                  </div>
                )}
                {media === "video" && resolvedCount > 0 && (
                  <div className="cnv-zoom ac-glass mf-zoom" role="toolbar" aria-label={t("files.comments.title")}>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={showResolved ? "eye" : "eyeOff"}
                      aria-pressed={showResolved}
                      onClick={() => setShowResolved((v) => !v)}
                    >
                      {t("files.comments.resolvedCount", { count: resolvedCount })}
                    </Button>
                  </div>
                )}
                <div className="mf-dockwrap">
                  <div className="cnv-dock ac-glass" role="toolbar" aria-label={t("live.canvas.tools.label")}>
                    <Button
                      variant="ghost"
                      iconOnly
                      icon="hand"
                      className="cnv-dock__tool"
                      aria-label={t("live.canvas.tools.hand")}
                      title={`${t("live.canvas.tools.hand")} (H)`}
                      aria-pressed={tool === "move"}
                      data-active={tool === "move" || undefined}
                      onClick={() => setTool("move")}
                    />
                    <span className="cnv-dock__divider" aria-hidden="true" />
                    <Button
                      variant="ghost"
                      iconOnly
                      icon="comment"
                      className="cnv-dock__tool"
                      aria-label={t("live.canvas.tools.comment")}
                      title={`${t("live.canvas.tools.comment")} (C)`}
                      aria-pressed={tool === "comment"}
                      data-active={tool === "comment" || undefined}
                      onClick={() => setTool((was) => (was === "comment" ? "move" : "comment"))}
                    />
                    {fileAgent && (
                      <>
                        <span className="cnv-dock__divider" aria-hidden="true" />
                        <Button variant="ghost" className="cnv-dock__agent" aria-label={askLabel} onClick={() => ask()}>
                          <AgentAvatar agentId={fileAgent.id} name={fileAgent.name} size="xs" />
                          <span className="ac-btn__label">{askLabel}</span>
                        </Button>
                      </>
                    )}
                  </div>
                  {tool === "comment" && (
                    <p className="mf-hint" role="status">
                      {t(`files.comments.hint.${media}` as "files.comments.hint.image")}
                    </p>
                  )}
                </div>
              </div>
            </div>
            {talkOpen && artifact && (
              <FileConversationPanel
                kind={media}
                rootId={talkRef?.rootId ?? null}
                docked={docked}
                focusMessageId={search.m}
                onClose={closeTalk}
              />
            )}
            {remover.dialog}
            {share.dialog}
          </div>
        </LiveAskContext.Provider>
      </FileAgentContext.Provider>
    </FileTalkContext.Provider>
  );
}

/**
 * The page's header, a live file's (`LiveHeader`) without what only a live file has (who is here, versions saved by
 * name, presenting): where it is, Share, the conversation's toggle and ⋯ (Download, Copy link, Show in Drive, Move to
 * trash), then its icon and title, and who made it and where.
 */
function MediaHeader({
  artifact,
  media,
  compact,
  talk,
  onShare,
  onCopyLink,
  onDownload,
  onDelete,
}: {
  artifact: ArtifactDetail | null;
  media: FileMediaKind;
  compact: boolean;
  talk: ReactNode;
  onShare: () => void;
  onCopyLink: () => void;
  onDownload: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  const shares = artifact?.inDrive !== false;
  const toDrive = () =>
    void navigate({
      to: "/org/$orgId/drive",
      params: { orgId: org.id },
      search: artifact ? { artifact: artifact.id } : {},
    });
  return (
    <header className="lf-head" data-kind={media}>
      <div className="lf-top">
        <LiveCrumbs artifact={artifact} />
        <div className="lf-top__acts">
          {artifact && (
            <>
              {!compact && shares && (
                <Button size="sm" icon="personAdd" className="mf-share" onClick={onShare}>
                  {t("share.button")}
                </Button>
              )}
              {talk}
              <Menu
                align="end"
                label={t("live.shell.more")}
                trigger={
                  <Button
                    size="sm"
                    variant="ghost"
                    iconOnly
                    icon="more"
                    aria-label={t("live.shell.more")}
                    title={t("live.shell.more")}
                  />
                }
              >
                {compact && shares && (
                  <>
                    <MenuItem icon="personAdd" onSelect={onShare}>
                      {t("share.button")}
                    </MenuItem>
                    <MenuSeparator />
                  </>
                )}
                <MenuItem icon="download" onSelect={onDownload}>
                  {t("artifacts.download")}
                </MenuItem>
                {shares && (
                  <MenuItem icon="link" onSelect={onCopyLink}>
                    {t("live.shell.menu.copyLink")}
                  </MenuItem>
                )}
                <MenuItem icon="drive" onSelect={toDrive}>
                  {t("live.shell.menu.showInDrive")}
                </MenuItem>
                {artifact.canDelete && (
                  <>
                    <MenuSeparator />
                    <MenuItem icon="trash" danger onSelect={onDelete}>
                      {t("live.shell.menu.trash")}
                    </MenuItem>
                  </>
                )}
              </Menu>
            </>
          )}
        </div>
      </div>
      <div className="lf-titleline ac-iconline">
        <Icon name={talkIcon(media)} className="lf-kind" />
        <h1 className={cx("lf-title lf-title--still")} title={artifact?.title}>
          {artifact?.title}
        </h1>
      </div>
      {artifact ? <LiveMeta artifact={artifact} onVersions={toDrive} /> : null}
    </header>
  );
}
