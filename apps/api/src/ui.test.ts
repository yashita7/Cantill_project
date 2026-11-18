import { Script } from "node:vm";
import { expect, it } from "vitest";
import { homePage } from "./home-page.js";
import { setupPage } from "./page.js";
import { chatPage } from "./chat-page.js";
import { buyerPage } from "./buyer-page.js";
import { policyPage } from "./policy-page.js";

it.each([homePage, setupPage, chatPage, buyerPage, policyPage])(
  "renders pages with valid inline JavaScript",
  (page) => {
    const scripts = [
      ...page.matchAll(/<script(?: type="module")?>([\s\S]*?)<\/script>/g),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts)
      expect(() => new Script(script[1])).not.toThrow();
    expect(page).toContain("/ui.css");
  },
);
