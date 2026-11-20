import { useArtifact, useThreadMessages } from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { Button, CountChip } from "@agenteschat/ui";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMaybeArtifactViewer } from "@/components/artifacts/ArtifactViewer";
import { useOrg } from "@/components/org-context";
import { ThreadLineBody } from "@/components/threads/ThreadLines";
import { openMediaPage } from "../open";
import { MediaPins } from "./MediaPins";
import { mediaPinsOf } from "./marks";

/*
 * The viewer, the preview first (ADR 0208): a picture, a video or a PDF opened from the chat or the Drive shows its
 * open comments' pins (their words on hover) and "Comment" and "Conversation N" over it; any of these goes to the
 * file's page, at that comment or with Comment on.
 */

/** The file's comments with a pin, and the way to its page (the viewer closes on the way). */
export function useViewerComments(artifactId: string) {
  const { org } = useOrg();
  const navigate = useNavigate();
  const viewer = useMaybeArtifactViewer();
  const artifact = useArtifact(org.id, artifactId).data;
  const talk = artifact?.conversation ?? null;
  const messages = useThreadMessages(org.id, talk?.channelId, talk?.rootId ?? "");
  const pins = useMemo(
    () => mediaPinsOf(messages.data ?? [], artifactId, artifact?.version ?? 1),
    [messages.data, artifactId, artifact?.version],
  );
  const go = (options: { m?: string; comment?: boolean } = {}) => {
    viewer?.close();
    openMediaPage(navigate, org.id, artifactId, options);
  };
  return { artifact, pins, media: mediaKindOfArtifact(artifact), count: talk?.count ?? 0, go };
}

/** Over the picture in the viewer: the open comments' pins; a press opens the page at that comment. */
export function ViewerPins({ artifactId }: { artifactId: string }) {
  const { pins, go } = useViewerComments(artifactId);
  if (!pins.length) return null;
  return <MediaPins pins={pins} showResolved={false} peek onOpen={(m) => go({ m })} />;
}

/** "Comment" and "Conversation N" in the viewer's header, for a picture, a video or a PDF. */
export function ViewerCommentButtons({ artifactId }: { artifactId: string }) {
  const { t } = useTranslation();
  const { media, count, go } = useViewerComments(artifactId);
  if (!media) return null;
  return (
    <>
      {/* Like the viewer's other actions: their words go on a narrow screen, their icon and name stay. */}
      <Button
        size="sm"
        variant="ghost"
        icon="comment"
        title={t("live.canvas.tools.comment")}
        onClick={() => go({ comment: true })}
      >
        <span className="artifact-action__label">{t("live.canvas.tools.comment")}</span>
      </Button>
      <Button size="sm" variant="ghost" icon="message" title={t("live.conversation.button")} onClick={() => go()}>
        <span className="artifact-action__label">{t("live.conversation.button")}</span>
        {count > 0 && <CountChip size="sm">{count}</CountChip>}
      </Button>
    </>
  );
}

/**
 * Under a picture, a video or a PDF posted in a conversation, once it has comments (ADR 0208): who commented, "3
 * comments on the image" and when, the look of a thread's line; a press opens its page with the conversation.
 */
export function ChatCommentsLine({ artifactId, version }: { artifactId: string; version?: number }) {
  const { t } = useTranslation();
  const { org } = useOrg();
  const navigate = useNavigate();
  // The card's own query (the same version): read once for both.
  const artifact = useArtifact(org.id, artifactId, version).data;
  const media = mediaKindOfArtifact(artifact);
  const talk = artifact?.conversation;
  if (!media || !talk || talk.count === 0) return null;
  return (
    <button
      type="button"
      className="thread-line mf-chatline"
      onClick={() => openMediaPage(navigate, org.id, artifactId)}
    >
      <ThreadLineBody
        people={talk.participants}
        label={t(`files.comments.line.${media}` as "files.comments.line.image", { count: talk.count })}
        at={talk.lastAt}
      />
    </button>
  );
}
