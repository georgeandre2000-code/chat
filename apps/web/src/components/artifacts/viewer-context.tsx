import type { ArtifactAuthor, ArtifactDetail, ArtifactRef } from "@agenteschat/client";
import { keys } from "@agenteschat/client";
import { isPreviewImage } from "@agenteschat/client/lib/files";
import { filePath } from "@agenteschat/client/lib/message-links";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, Suspense, useCallback, useContext, useMemo, useState } from "react";
import { knownLive, openLivePage } from "@/components/live/open";
import { useOrg } from "@/components/org-context";
import { useDirectory } from "@/hooks/useDirectory";
import { lazyDialog } from "@/lib/lazy-dialog";

/*
 * Opening a file in the workspace's side panel, as the shell holds it: the context, its provider and the hooks. The
 * viewer itself (`ArtifactViewer.tsx`, with every kind's view and editor) comes when a file opens.
 */

const LazyArtifactViewer = lazyDialog(() => import("./ArtifactViewer").then((m) => m.ArtifactViewer));

/** Link to an artifact (opens Drive with the viewer). */
export const artifactLink = (origin: string, orgId: string, id: string, version?: number) =>
  `${origin}${filePath(orgId, id, version)}`;

/** An artifact at a version (the latest when left out). */
export interface ViewerItem {
  id: string;
  version?: number | undefined;
}

interface ViewerTarget extends ViewerItem {
  /** The pictures of the message it opened from, in its order, to move through. */
  set?: ViewerItem[] | undefined;
  /** The one it opened on: moving through `set` keeps the same dialog, only its picture changes. */
  key: string;
}

const ViewerContext = createContext<{
  open: (id: string, version?: number, set?: ViewerItem[]) => void;
  close: () => void;
} | null>(null);

/** Opens artifacts in the side panel from anywhere in the workspace (chat cards, Drive). */
export function ArtifactViewerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ViewerTarget | null>(null);
  const { org } = useOrg();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const orgId = org.id;
  const open = useCallback(
    (id: string, version?: number, set?: ViewerItem[]) => {
      // A spreadsheet, a presentation or a canvas opens on its own page (ADR 0196 §9), not in the viewer.
      if (knownLive(qc, orgId, id)) openLivePage(navigate, orgId, id, { version });
      else setTarget({ id, version, set, key: id });
    },
    [qc, orgId, navigate],
  );
  const close = useCallback(() => setTarget(null), []);
  const value = useMemo(() => ({ open, close }), [open, close]);
  return (
    <ViewerContext.Provider value={value}>
      {children}
      <Suspense fallback={null}>
        {target && (
          <LazyArtifactViewer
            key={target.key}
            id={target.id}
            version={target.version}
            set={target.set}
            onVersion={(version) => setTarget({ ...target, version })}
            onMove={(item) => setTarget({ ...target, id: item.id, version: item.version })}
            onClose={close}
          />
        )}
      </Suspense>
    </ViewerContext.Provider>
  );
}

/** The pictures `ImageSet` opens a picture of its message with (two or more), or none. */
const ImageSetContext = createContext<((id: string) => ViewerItem[] | undefined) | null>(null);

/**
 * Around a message's attachments: a picture among them opens in the viewer with the message's other pictures, in its
 * order, to move through. Read when one opens, from the queries its cards loaded them with (`useArtifact` at the
 * ref's version).
 */
export function ImageSet({ refs, children }: { refs: ArtifactRef[]; children: ReactNode }) {
  const { org } = useOrg();
  const qc = useQueryClient();
  const setOf = (id: string) => {
    const set = refs.flatMap((r) => {
      const a = r.deleted ? undefined : qc.getQueryData<ArtifactDetail>(keys.artifact(org.id, r.id, r.version));
      return a?.content.kind === "file" && isPreviewImage(a.content)
        ? [{ id: a.id, version: a.shownVersion < a.version ? a.shownVersion : undefined }]
        : [];
    });
    return set.length > 1 && set.some((i) => i.id === id) ? set : undefined;
  };
  return <ImageSetContext.Provider value={setOf}>{children}</ImageSetContext.Provider>;
}

export function useArtifactViewer() {
  const value = useContext(ViewerContext);
  const setOf = useContext(ImageSetContext);
  if (!value) throw new Error("useArtifactViewer must be used inside ArtifactViewerProvider");
  return setOf ? { ...value, open: (id: string, version?: number) => value.open(id, version, setOf(id)) } : value;
}

/** The viewer where there is one; a text with no viewer around it (a page of its own) opens the Drive instead. */
export const useMaybeArtifactViewer = () => useContext(ViewerContext);

export function useAuthorName() {
  const { org } = useOrg();
  const dir = useDirectory(org.id);
  return (a: ArtifactAuthor) => dir.authorName({ type: a.type, id: a.id } as Parameters<typeof dir.authorName>[0]);
}
