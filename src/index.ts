import { ManekiWidgetElement } from "./element";

export { ManekiWidgetElement } from "./element";
export type { WidgetState } from "./state";

const TAG_NAME = "maneki-widget";

if (!customElements.get(TAG_NAME)) {
  customElements.define(TAG_NAME, ManekiWidgetElement);
}
