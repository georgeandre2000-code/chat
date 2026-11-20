import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Actor, ApiClient, LiveSelection, Message } from "@agenteschat/client";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { fileSaver } from "@/components/artifacts/ArtifactViewer";
import { objectUrls } from "@/components/artifacts/FileView";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/*
 * Comments on a picture (ADR 0208), as live files have them (ADR 0199): the picture's own page (its header, Move and
 * Comment under it, its comments pinned on it with who wrote them and their number, the resolved ones hidden until
 * asked for), a click with Comment on that goes in the conversation's composer as "Sobre o ponto N da imagem" and
 * rides on the message, Resolver on a pinned comment and who resolved it under it, Comentar and Conversa in the
 * viewer with the pins over the picture, and the line under a picture posted in a chat once it has comments. Videos
 * and PDFs share all of this but their stages (a PDF's draws with pdf.js, kept out of these tests).
 */

/** The picture's stage and, in the viewer, the zoom's stage: a size, as a browser lays them out (happy-dom doesn't). */
const STAGE = { w: 1000, h: 700 };
/** Where the picture's box is on screen once fitted (its page's `.mf-box`). */
const BOX = { left: 100, top: 50, width: 400, height: 200 };
const sized = (el: Element) => el.classList?.contains("mf-stage") || el.classList?.contains("izoom__stage");
const realRect = Element.prototype.getBoundingClientRect;
const realSize = ["clientWidth", "clientHeight"].map(
  (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
);
const realSave = fileSaver.save;
const realCreate = objectUrls.create;
const realRevoke = objectUrls.revoke;
let urls = 0;
beforeAll(() => {
  fileSaver.save = () => {};
  objectUrls.create = () => `blob:picture-${++urls}`;
  objectUrls.revoke = () => {};
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const r = this.classList?.contains("mf-box")
      ? { ...BOX, right: BOX.left + BOX.width, bottom: BOX.top + BOX.height }
      : sized(this)
        ? { left: 0, top: 0, width: STAGE.w, height: STAGE.h, right: STAGE.w, bottom: STAGE.h }
        : null;
    if (!r) return realRect.call(this);
    const rect = { ...r, x: r.left, y: r.top };
    return { ...rect, toJSON: () => rect } as DOMRect;
  };
  for (const [k, d] of realSize) {
    const size = k === "clientWidth" ? STAGE.w : STAGE.h;
    Object.defineProperty(HTMLElement.prototype, k, {
      configurable: true,
      get(this: HTMLElement) {
        return sized(this) ? size : (d?.get?.call(this) ?? 0);
      },
    });
  }
});
afterAll(() => {
  fileSaver.save = realSave;
  objectUrls.create = realCreate;
  objectUrls.revoke = realRevoke;
  Element.prototype.getBoundingClientRect = realRect;
  for (const [k, d] of realSize) if (d) Object.defineProperty(HTMLElement.prototype, k, d);
});
afterEach(() => {
  cleanup();
  // The conversation's open or closed state is kept in the browser: each test starts fresh.
  window.localStorage.clear();
});

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const header = () => within(document.querySelector(".lf-head") as HTMLElement);
const panel = () => document.querySelector("aside.lf-talk") as HTMLElement | null;
const pins = () => [...document.querySelectorAll<HTMLElement>(".mf-pins .mf-pin")];
const pinNames = () => pins().map((p) => p.getAttribute("aria-label"));
const png = (name: string) =>
  new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])], name, { type: "image/png" });

/** A comment in the picture's conversation: who wrote it, its words, where it points, and its `meta.resolved`. */
interface Comment {
  id: string;
  by: Actor;
  body: string;
  selection?: LiveSelection;
  resolved?: { by: Actor; at: string };
}

/**
 * A picture uploaded in #eng whose conversation the fake server already made (its root stands for the file), with
 * `comments` in it; the file says how many (`count`) and who wrote there, as the server's would.
 */
async function pictureWithTalk({
  comments = [],
  count = comments.length,
}: {
  comments?: Comment[];
  count?: number;
} = {}) {
  const state = seedState();
  const api = createFakeApi(state);
  const file = await api.artifacts.upload(ORG_ID, png("banner.png"), { channelId: ENG_ID });
  const channelId = `file-conversation-${file.id}`;
  const rootId = `file-root-${file.id}`;
  const at = (minutes: number) => new Date(Date.now() - (60 - minutes) * 60_000).toISOString();
  state.messages.push({
    id: rootId,
    channelId,
    threadId: null,
    author: { type: "person", id: "u-walter" },
    body: "banner.png",
    mentionedAgentIds: [],
    agentRunId: null,
    clientId: null,
    meta: { fileConversation: { artifactId: file.id, kind: "image", title: "banner.png" } },
    createdAt: at(0),
  });
  for (const [i, c] of comments.entries()) {
    const meta: Record<string, unknown> = {};
    if (c.selection) meta.liveRef = { artifactId: file.id, kind: "image", title: "banner.png", selection: c.selection };
    if (c.resolved) meta.resolved = c.resolved;
    state.messages.push({
      id: c.id,
      channelId,
      threadId: rootId,
      author: c.by,
      body: c.body,
      mentionedAgentIds: [],
      agentRunId: null,
      clientId: null,
      meta,
      createdAt: at(i + 1),
    } as Message);
  }
  // The file as the server sends it: its size read on upload, and its conversation once it has messages.
  const get = api.artifacts.get;
  api.artifacts.get = async (...args) => {
    const detail = await get(...args);
    if (detail.id !== file.id || detail.content.kind !== "file") return detail;
    return {
      ...detail,
      content: { ...detail.content, width: 1200, height: 800 },
      conversation:
        count > 0
          ? {
              channelId,
              rootId,
              count,
              lastAt: at(comments.length),
              participants: [
                ...new Map<string, Actor>(comments.map((c) => [`${c.by.type}:${c.by.id}`, c.by])).values(),
              ],
              working: false,
            }
          : null,
    };
  };
  return { api, state, file, channelId, rootId };
}

const point = (n: number, x: number, y: number): LiveSelection => ({ label: String(n), mark: { x, y }, version: 1 });
const area = (n: number, x: number, y: number, w: number, h: number): LiveSelection => ({
  label: String(n),
  mark: { x, y, w, h },
  version: 1,
});
const joao: Actor = { type: "person", id: "u-joao" };
const ada: Actor = { type: "agent", id: ADA_ID };
/** Two open comments and one Ada resolved. */
const THREE: Comment[] = [
  { id: "c-1", by: joao, body: "O título está cortado aqui.", selection: point(1, 0.2, 0.3) },
  { id: "c-2", by: ada, body: "Aumentei a margem do logo.", selection: area(2, 0.5, 0.1, 0.25, 0.2) },
  {
    id: "c-3",
    by: joao,
    body: "Cor do botão mais escura.",
    selection: point(3, 0.8, 0.8),
    resolved: { by: ada, at: new Date().toISOString() },
  },
];

async function openPage(api: ApiClient, fileId: string, search = "") {
  const app = await renderApp(`/org/${ORG_ID}/drive/${fileId}${search}`, { api });
  await settle(8);
  await waitFor(() => expect(document.querySelector(".mf-root")).toBeTruthy());
  return app;
}

describe("a picture's page", () => {
  test("its header, Move and Comment under it, and its open comments pinned with who wrote them", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    await openPage(api, file.id);
    const page = document.querySelector(".mf-root") as HTMLElement;
    expect(page.dataset.kind).toBe("image");
    // A page of the app, as a live file's: the sidebar stays; no live file's editor.
    expect(document.querySelector(".sidebar")).toBeTruthy();
    expect(header().getByRole("heading", { level: 1 }).textContent).toBe("banner.png");
    expect(header().getByRole("button", { name: "Conversa, 3 mensagens" })).toBeTruthy();
    expect(header().getByRole("button", { name: "Mais" })).toBeTruthy();
    expect(document.title).toBe("banner.png");
    // Under the picture: Move (on), Comment, and asking the file's agent.
    const dock = within(screen().getByRole("toolbar", { name: "Ferramentas" }));
    expect(dock.getByRole("button", { name: "Mover a tela" }).getAttribute("aria-pressed")).toBe("true");
    expect(dock.getByRole("button", { name: "Comentar" }).getAttribute("aria-pressed")).toBe("false");
    // The picture itself, from its own bytes.
    expect(document.querySelector<HTMLImageElement>(".mf-img")?.getAttribute("src")).toMatch(/^blob:picture-/);
    // Its open comments, numbered oldest first with who wrote them; the resolved one is gone.
    await waitFor(() => expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada"]));
    expect(pins().map((p) => p.querySelector(".mf-pin__n")?.textContent)).toEqual(["1", "2"]);
    // A point's pin stands on it; an area's on its top right corner.
    expect([pins()[0]?.style.left, pins()[0]?.style.top]).toEqual(["20%", "30%"]);
    expect([pins()[1]?.style.left, pins()[1]?.style.top]).toEqual(["75%", "10%"]);
    // Its words on hover.
    expect(pins()[0]?.getAttribute("title")).toBe("João: O título está cortado aqui.");
  });

  test("the resolved ones come back faded with 1 resolvido, and go again", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    await openPage(api, file.id);
    await waitFor(() => expect(pins()).toHaveLength(2));
    const zoom = within(screen().getByRole("toolbar", { name: "Zoom do quadro" }));
    const show = zoom.getByRole("button", { name: "1 resolvido" });
    expect(show.getAttribute("aria-pressed")).toBe("false");
    expect(show.getAttribute("title")).toBe("Mostrar os resolvidos");
    await click(show);
    await settle(2);
    expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada", "Comentário 3 de João"]);
    expect(pins().map((p) => p.classList.contains("mf-pin--faded"))).toEqual([false, false, true]);
    expect(show.getAttribute("aria-pressed")).toBe("true");
    await click(show);
    await settle(2);
    expect(pins()).toHaveLength(2);
  });

  test("a pin opens the conversation at its message", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    // Closed by this person before.
    window.localStorage.setItem(`agentes.live.talk.u-walter.${ORG_ID}`, "0");
    const app = await openPage(api, file.id);
    expect(panel()).toBeNull();
    await waitFor(() => expect(pins()).toHaveLength(2));
    await click(pins()[1] as HTMLElement);
    await settle(8);
    await waitFor(() => expect(panel()).toBeTruthy());
    expect(pins()[1]?.classList.contains("mf-pin--on")).toBe(true);
    // The area of the comment open now is outlined.
    expect(document.querySelector<HTMLElement>(".mf-pins .mf-area")?.style.width).toBe("25%");
    await waitFor(() => expect(app.router.state.location.search).toMatchObject({ m: "c-2" }));
  });

  test("Comment: a click marks a point, the composer says so, and the message carries it", async () => {
    const { api, state, file } = await pictureWithTalk({ comments: THREE });
    await openPage(api, file.id);
    await waitFor(() => expect(pins()).toHaveLength(2));
    const dock = within(screen().getByRole("toolbar", { name: "Ferramentas" }));
    await click(dock.getByRole("button", { name: "Comentar" }));
    expect(dock.getByRole("button", { name: "Comentar" }).getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".mf-hint")?.textContent).toBe(
      "Clique para marcar um ponto ou arraste para marcar uma área",
    );
    // A press and its release a quarter of the way into the picture's box.
    const stage = document.querySelector(".mf-stage") as HTMLElement;
    const at = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 200, clientY: 100 };
    await act(async () => fireEvent.pointerDown(stage, at));
    await act(async () => fireEvent.pointerUp(stage, { ...at, buttons: 0 }));
    await settle(8);
    // Back to moving; the draft's pin takes the next number, with my face.
    expect(dock.getByRole("button", { name: "Comentar" }).getAttribute("aria-pressed")).toBe("false");
    const draft = document.querySelector<HTMLElement>(".mf-pin--draft");
    expect(draft?.querySelector(".mf-pin__n")?.textContent).toBe("4");
    expect([draft?.style.left, draft?.style.top]).toEqual(["25%", "25%"]);
    const quote = await waitFor(() => document.querySelector(".lf-quote") as HTMLElement);
    expect(quote.textContent).toBe("Sobre o ponto 4 da imagem");
    const composer = within(panel() as HTMLElement).getByRole("combobox", {
      name: "Escrever sobre a imagem · use @ para chamar um agente",
    });
    await type(composer, "Esse ícone está borrado");
    await act(async () => fireEvent.keyDown(composer, { key: "Enter" }));
    await settle(8);
    const post = await waitFor(() => {
      const found = state.calls.filter((c) => c.method === "chat.post").at(-1);
      if (!found) throw new Error("not posted yet");
      return found;
    });
    expect((post.args[2] as { liveRef?: unknown }).liveRef).toEqual({
      artifactId: file.id,
      selection: { label: "4", mark: { x: 0.25, y: 0.25 }, version: 1 },
    });
    // Sent: the quote and the draft's pin go.
    expect(document.querySelector(".lf-quote")).toBeNull();
    expect(document.querySelector(".mf-pin--draft")).toBeNull();
  });

  test("C turns Comment on and Esc off; × on the quote drops the comment being written", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    await openPage(api, file.id);
    const comment = () =>
      within(screen().getByRole("toolbar", { name: "Ferramentas" })).getByRole("button", { name: "Comentar" });
    await act(async () => fireEvent.keyDown(window, { key: "c" }));
    expect(comment().getAttribute("aria-pressed")).toBe("true");
    await act(async () => fireEvent.keyDown(window, { key: "Escape" }));
    expect(comment().getAttribute("aria-pressed")).toBe("false");
    await click(comment());
    const stage = document.querySelector(".mf-stage") as HTMLElement;
    // A drag: an area.
    const from = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: 100, clientY: 50 };
    await act(async () => fireEvent.pointerDown(stage, from));
    await act(async () => fireEvent.pointerMove(stage, { ...from, clientX: 300, clientY: 150 }));
    await act(async () => fireEvent.pointerUp(stage, { ...from, buttons: 0, clientX: 300, clientY: 150 }));
    await settle(8);
    const quote = await waitFor(() => document.querySelector(".lf-quote") as HTMLElement);
    expect(quote.textContent).toBe("Sobre a área 4 da imagem");
    expect(document.querySelector<HTMLElement>(".mf-area--draft")?.style.width).toBe("50%");
    await click(screen().getByRole("button", { name: "Não mandar a seleção" }));
    await settle(2);
    expect(document.querySelector(".lf-quote")).toBeNull();
    expect(document.querySelector(".mf-area--draft")).toBeNull();
  });

  test("the page opens with Comment on from the viewer's Comentar (?comment)", async () => {
    const { api, file } = await pictureWithTalk();
    await openPage(api, file.id, "?comment=true");
    const dock = within(screen().getByRole("toolbar", { name: "Ferramentas" }));
    expect(dock.getByRole("button", { name: "Comentar" }).getAttribute("aria-pressed")).toBe("true");
    // No comments yet: no pins, no resolved count, and Conversa with no count.
    expect(pins()).toHaveLength(0);
    expect(screen().queryByRole("button", { name: /resolvid/ })).toBeNull();
    expect(header().getByRole("button", { name: "Conversa" })).toBeTruthy();
  });
});

describe("Resolver in a picture's conversation", () => {
  test("a pinned comment has Resolver; resolved, it says who and when, and Reabrir puts it back", async () => {
    const comments: Comment[] = [
      ...THREE,
      // About the picture, with no place in it: nothing to resolve.
      { id: "c-plain", by: joao, body: "Ficou ótima.", selection: { label: "banner.png" } },
    ];
    const { api, state, file } = await pictureWithTalk({ comments });
    await openPage(api, file.id);
    const talk = await waitFor(() => {
      const open = panel();
      if (!open) throw new Error("the conversation isn't open yet");
      return open;
    });
    const row = async (id: string) =>
      within(
        await waitFor(() => {
          const el = talk.querySelector<HTMLElement>(`article[data-message-id="${id}"]`);
          if (!el) throw new Error(`no message ${id} yet`);
          return el;
        }),
      );
    const first = await row("c-1");
    const resolve = first.getByRole("button", { name: "Resolver" });
    expect(resolve.getAttribute("aria-pressed")).toBe("false");
    expect(first.queryByText(/^Resolvido por/)).toBeNull();
    // The comment that was resolved says by whom; Ada's own comment has Resolver on her bar too.
    expect((await row("c-3")).getByText(/^Resolvido por Ada · \d{1,2}:\d{2}/)).toBeTruthy();
    expect((await row("c-3")).getByRole("button", { name: "Reabrir" }).getAttribute("aria-pressed")).toBe("true");
    expect((await row("c-2")).getByRole("button", { name: "Resolver" })).toBeTruthy();
    expect((await row("c-plain")).queryByRole("button", { name: "Resolver" })).toBeNull();

    await click(resolve);
    await settle(6);
    expect(state.calls.find((c) => c.method === "live.resolveComment")?.args).toEqual([ORG_ID, "c-1", true]);
    await waitFor(() => expect(first.getByText(/^Resolvido por Walter · \d{1,2}:\d{2}/)).toBeTruthy());
    expect(first.getByRole("button", { name: "Reabrir" }).getAttribute("aria-pressed")).toBe("true");
    // Its pin leaves the picture.
    await waitFor(() => expect(pinNames()).toEqual(["Comentário 2 de Ada"]));

    await click(first.getByRole("button", { name: "Reabrir" }));
    await settle(6);
    expect(state.calls.filter((c) => c.method === "live.resolveComment").at(-1)?.args).toEqual([ORG_ID, "c-1", false]);
    await waitFor(() => expect(first.queryByText(/^Resolvido por/)).toBeNull());
    expect(pinNames()).toEqual(["Comentário 1 de João", "Comentário 2 de Ada"]);
  });

  test("a message about part of the picture has its line; a click opens its pin", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    await openPage(api, file.id);
    const talk = await waitFor(() => {
      const open = panel();
      if (!open) throw new Error("the conversation isn't open yet");
      return open;
    });
    const line = await waitFor(() =>
      within(talk).getByRole("button", { name: "Mostrar Área 2 (na imagem) no arquivo" }),
    );
    expect(line.querySelector(".msg-quote__who")?.textContent).toBe("Área 2");
    await click(line);
    await settle(2);
    expect(pins()[1]?.classList.contains("mf-pin--on")).toBe(true);
  });
});

describe("a picture in the viewer", () => {
  /** The viewer's picture has loaded at its size: fitted, its box placed, the overlay with it. */
  const load = async (dialog: HTMLElement) => {
    const img = dialog.querySelector<HTMLImageElement>(".izoom__img");
    if (!img) throw new Error("no picture in the viewer");
    Object.defineProperty(img, "naturalWidth", { value: 1200 });
    Object.defineProperty(img, "naturalHeight", { value: 800 });
    await act(async () => fireEvent.load(img));
    await settle(2);
  };

  test("Comentar and Conversa N in its header, its open comments' pins over it; Comentar opens its page", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const app = await renderApp(`/org/${ORG_ID}/drive?artifact=${file.id}`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "banner.png" });
    const actions = within(dialog.querySelector(".ac-details__actions") as HTMLElement);
    await waitFor(() => expect(actions.getByRole("button", { name: "Comentar" })).toBeTruthy());
    expect(actions.getByRole("button", { name: /^Conversa/ }).textContent).toBe("Conversa3");
    await load(dialog);
    const over = await waitFor(() => dialog.querySelector(".izoom__overlay") as HTMLElement);
    await waitFor(() =>
      expect([...over.querySelectorAll(".mf-pin")].map((p) => p.getAttribute("aria-label"))).toEqual([
        "Comentário 1 de João",
        "Comentário 2 de Ada",
      ]),
    );
    // The viewer has no conversation beside it: the words show on hover, with where a click goes.
    const first = over.querySelector(".mf-pin") as HTMLElement;
    expect(first.getAttribute("title")).toBeNull();
    await act(async () => fireEvent.pointerEnter(first));
    expect(over.querySelector(".mf-peek")?.textContent).toContain("O título está cortado aqui.");
    expect(over.querySelector(".mf-peek")?.textContent).toContain("Clique para abrir na conversa");

    await click(actions.getByRole("button", { name: "Comentar" }));
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive/${file.id}`);
    expect(app.router.state.location.search).toMatchObject({ comment: true });
    expect(screen().queryByRole("dialog", { name: "banner.png" })).toBeNull();
    await waitFor(() =>
      expect(
        within(screen().getByRole("toolbar", { name: "Ferramentas" }))
          .getByRole("button", { name: "Comentar" })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });

  test("a pin in the viewer opens the page at its comment", async () => {
    const { api, file } = await pictureWithTalk({ comments: THREE });
    const app = await renderApp(`/org/${ORG_ID}/drive?artifact=${file.id}`, { api });
    await settle(8);
    const dialog = screen().getByRole("dialog", { name: "banner.png" });
    await load(dialog);
    const pin = await waitFor(() => dialog.querySelector(".izoom__overlay .mf-pin") as HTMLElement);
    await click(pin);
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive/${file.id}`);
    expect(app.router.state.location.search).toMatchObject({ m: "c-1" });
  });

  test("a file that isn't a picture, a video or a PDF has neither", async () => {
    const api = createFakeApi(seedState());
    const zip = await api.artifacts.upload(ORG_ID, new File([new Uint8Array([80, 75, 3, 4])], "notas.zip"));
    await renderApp(`/org/${ORG_ID}/drive?artifact=${zip.id}`, { api });
    await settle(8);
    const dialog = within(screen().getByRole("dialog", { name: "notas.zip" }));
    expect(dialog.queryByRole("button", { name: "Comentar" })).toBeNull();
    expect(dialog.queryByRole("button", { name: /^Conversa/ })).toBeNull();
  });
});

describe("a picture posted in a chat", () => {
  async function postedIn(comments: Comment[], count = comments.length) {
    const made = await pictureWithTalk({ comments, count });
    made.state.messages.push({
      id: "m-picture",
      channelId: ENG_ID,
      threadId: null,
      author: { type: "agent", id: ATLAS_ID },
      body: "A arte nova do banner.",
      mentionedAgentIds: [],
      agentRunId: "r-picture",
      meta: { artifacts: [{ id: made.file.id, version: 1 }] },
      createdAt: new Date().toISOString(),
    });
    const app = await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: made.api });
    await settle(10);
    return { ...made, app };
  }
  const row = () => document.querySelector(`article[data-message-id="m-picture"]`) as HTMLElement;

  test("once it has comments: who commented and 3 comentários na imagem under it; a press opens its page", async () => {
    const { app, file } = await postedIn(THREE);
    const line = await waitFor(() => row().querySelector(".mf-chatline") as HTMLElement);
    expect(line.querySelector("b")?.textContent).toBe("3 comentários na imagem");
    expect(line.classList.contains("thread-line")).toBe(true);
    await click(line);
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/drive/${file.id}`);
  });

  test("one comment is said in the singular; none, no line", async () => {
    await postedIn(THREE.slice(0, 1));
    const line = await waitFor(() => row().querySelector(".mf-chatline") as HTMLElement);
    expect(line.querySelector("b")?.textContent).toBe("1 comentário na imagem");
    cleanup();
    await postedIn([]);
    await waitFor(() => expect(row()).toBeTruthy());
    expect(row().querySelector(".mf-chatline")).toBeNull();
  });
});
