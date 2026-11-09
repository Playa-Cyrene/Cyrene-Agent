import { JSDOM } from "jsdom";
import type { WebContents } from "electron";
import { expect, it } from "vitest";
import {
  capturePlaywrightPageSnapshot, readPlaywrightElementPicker, startPlaywrightElementPicker, validatePlaywrightSnapshotTarget,
} from "./playwright-page-snapshot";

it("preserves live fields and refs while excluding values from the tree, element metadata and picker", async () => {
  const dom = new JSDOM(`
    <article>
      <label for="password">Password</label><input id="password" type="password" value="secret-password">
      <label for="otp">One-time code</label><input id="otp" autocomplete="one-time-code" value="secret-otp">
      <label for="notes">Notes</label><textarea id="notes">secret-default</textarea>
      <div role="textbox" contenteditable>secret-editable</div>
      <div id="shadow-editable" role="searchbox" contenteditable></div>
      <label for="number">Numeric code</label><input id="number" type="number" value="867530987654">
      <button aria-labelledby="number">Lookup number</button>
      <div id="slider" role="slider" aria-valuetext="secret-range"></div>
      <button aria-labelledby="slider">Lookup range</button>
      <button aria-labelledby="otp">Lookup</button>
      <label for="payment">Payment method</label>
      <select id="payment"><option>First choice</option><option>Second choice</option></select>
      <button id="lookup-payment" aria-labelledby="payment">Lookup payment</button>
      <input type="submit" value="Submit order">
      <p>Public page content</p>
    </article>
  `, { runScripts: "outside-only", pretendToBeVisual: true });
  const { document } = dom.window;
  const getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle = (element) => getComputedStyle(element);
  const rect = new dom.window.DOMRect(0, 0, 120, 20);
  dom.window.Element.prototype.getBoundingClientRect = () => rect;
  const otp = document.querySelector<HTMLInputElement>("#otp")!;
  const notes = document.querySelector<HTMLTextAreaElement>("#notes")!;
  const payment = document.querySelector<HTMLSelectElement>("#payment")!;
  payment.selectedIndex = 1;
  // JSDOM does not generate Chromium's selected option clone.
  const clone = document.createElement("selectedcontent");
  clone.textContent = "secret-option-clone";
  const paymentButton = document.createElement("button");
  paymentButton.append(clone);
  payment.prepend(paymentButton);
  document.querySelector("#shadow-editable")!.attachShadow({ mode: "open" }).textContent = "secret-shadow";
  notes.value = "secret-live-note\nsecond line";
  document.elementFromPoint = () => otp;
  const contents = {
    executeJavaScriptInIsolatedWorld: async (_world: number, scripts: Array<{ code: string }>) =>
      dom.window.eval(scripts[0].code),
  } as unknown as WebContents;

  try {
    const snapshot = await startPlaywrightElementPicker(contents);
    const target = snapshot.elements.find((element) => element.id === "otp");
    expect(target?.ref).toBeTruthy();
    expect(snapshot.ariaSnapshot).toContain("Password");
    expect(snapshot.ariaSnapshot).toContain("One-time code");
    expect(snapshot.ariaSnapshot).toContain("Submit order");
    expect(snapshot.ariaSnapshot).toContain("Public page content");
    expect(snapshot.ariaSnapshot).toContain("Numeric code");
    expect(JSON.stringify(snapshot)).not.toMatch(/secret-|second line|867530987654/);
    expect(snapshot.elements.find((element) => element.id === "payment")).toMatchObject({
      ref: expect.any(String), description: expect.stringContaining("Payment method"),
    });
    expect(snapshot.ariaSnapshot).toContain('option "First choice"');
    expect(snapshot.ariaSnapshot).toContain('option "Second choice"');
    expect(snapshot.ariaSnapshot).not.toContain("[selected]");
    expect(snapshot.elements.find((element) => element.id === "lookup-payment")?.description).not.toMatch(/First choice|Second choice/);

    const { observationId } = snapshot;
    expect(await validatePlaywrightSnapshotTarget(contents, {
      observationId, ref: target!.ref, description: target!.description, x: 10, y: 10,
    })).toMatchObject({ ok: true });
    otp.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    const picker = await readPlaywrightElementPicker(contents);
    expect(picker.selected).toMatchObject({ ref: target!.ref, snapshotLine: expect.stringContaining("One-time code") });
    expect(JSON.stringify(picker)).not.toMatch(/secret-|second line/);
    expect(otp.value).toBe("secret-otp");
    expect(notes.value).toBe("secret-live-note\nsecond line");
    expect(payment.selectedIndex).toBe(1);
    expect(clone.textContent).toBe("secret-option-clone");
    payment.selectedIndex = 0;
    expect((await capturePlaywrightPageSnapshot(contents)).ariaSnapshot).toBe(snapshot.ariaSnapshot);
    expect(payment.selectedIndex).toBe(0);
  } finally {
    dom.window.close();
  }
});
