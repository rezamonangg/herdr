import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { focused, shared, setShared, theme } from "herdr";

// One floating block per comment: every card is its own component with its
// own native frame and its own drag spot — dragging one moves only that
// card. Slot indexes the visible (not closed) human comments, newest first;
// a slot past the end renders nothing, which hides its block.
export function commentCard(slot) {
  const id = focused()?.space;
  const card = (shared("github-spaces.comments") ?? {})[id];
  if (!card) return div();
  // A legacy whole-dock "dismissed" closes everything it knew; ids win.
  const dismissed = new Set(Array.isArray(card.dismissedIds) ? card.dismissedIds
    : card.dismissed ? (card.comments ?? []).map(c => c.id) : []);
  const comments = (card.comments ?? []).filter(c => !/bot/i.test(c.author ?? "") && !dismissed.has(c.id));
  const c = comments[slot];
  if (!c) return div();
  const t = theme();
  const link = c.url && div().id(`open-${c.id}`).cursor_pointer().text_size(11).text_color(t.accent)
    .tooltip(c.url).hover(s => s.text_color(t.foreground))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(c.url); })
    .child("View on GitHub ↗");
  return v_flex().w(360).p(10).gap(5).text_color(t.foreground)
    .child(h_flex().items_center().gap(8)
      .child(div().flex_1().truncate().text_size(11).font_semibold().text_color(t.muted)
        .child(`${c.author} · ${c.at.replace("T", " ").replace("Z", " UTC")}`))
      .child(div().id(`close-${c.id}`).size(20).flex().items_center().justify_center().rounded(4)
        .cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Close this comment")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const all = shared("github-spaces.comments") ?? {};
          const latest = all[id];
          // Dismissing by id stays safe when newer activity arrived; a comment
          // that rolled out of the list is simply gone already.
          if (!latest?.comments?.some(x => x.id === c.id)) return;
          setShared("github-spaces.comments", { ...all, [id]: {
            ...latest, dismissedIds: [...new Set([...(latest.dismissedIds ?? []), c.id])],
          } });
        }).child("×")))
    .child(div().text_size(10.5).text_color(t.muted).child(
      `${card.title}${slot === 0 && comments.length > 1 ? ` · ${comments.length - 1} more behind` : ""}`))
    .child(div().text_size(12).child(c.body))
    .child(h_flex().justify_end().when(Boolean(link), el => el.child(link)));
}
