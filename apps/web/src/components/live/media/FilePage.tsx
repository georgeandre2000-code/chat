import { useArtifact } from "@agenteschat/client";
import { mediaKindOfArtifact } from "@agenteschat/client/lib/files";
import { useOrg } from "@/components/org-context";
import { LiveFilePage, type LiveFileSearch } from "../LiveFilePage";
import { MediaFilePage } from "./MediaFilePage";

/**
 * A file's page: a picture, a video or a PDF with its comments (ADR 0208), else a live file's editor (ADR 0196 §9),
 * which also sends anything else back to the Drive's viewer. Decided by the file as loaded (the same query both read).
 */
export function FilePage(props: {
  fileId: string;
  search: LiveFileSearch;
  onSearch: (patch: Partial<LiveFileSearch>) => void;
}) {
  const { org } = useOrg();
  const artifact = useArtifact(org.id, props.fileId).data;
  const media = mediaKindOfArtifact(artifact);
  // Until the file is known, the live file's page: it is the one that tells a file that doesn't exist (its room).
  return media && artifact ? <MediaFilePage {...props} media={media} /> : <LiveFilePage {...props} />;
}
