import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { focused, shared, setShared, theme } from "herdr";

export function commentDock() {
  const id = focused()?.space;
  const cards = shared("github-spaces.comments") ?? {};
  const card = cards[id];
  if (!card || card.dismissed) return div();
  const t = theme();
  return v_flex().w(350).p(14).gap(9).text_color(t.foreground)
    .child(h_flex().items_center().gap(10)
      .child(div().flex_1().truncate().font_semibold().text_size(12).child(card.title))
      .child(div().id("dismiss-pr-comment").size(24).flex().items_center().justify_center()
        .rounded(4).cursor_pointer().hover(s => s.bg(t.hover)).tooltip("Dismiss comment")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const latest = shared("github-spaces.comments") ?? {};
          if (latest[id]?.at === card.at) setShared("github-spaces.comments", {
            ...latest, [id]: { ...latest[id], dismissed: true },
          });
        }).child("×")))
    .child(div().text_size(12).child(card.body))
    .child(div().text_size(10).text_color(t.muted).child("PR activity · stays until dismissed"));
}
