// @vitest-environment node
// Node, not jsdom: the manifest tests import wxt.config.ts, which reads files by file: URL.
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Edge and Firefox.
 *
 * Edge takes the Chrome zip unchanged, so all it needs is to be called by its own name.
 * Firefox gets its own build, and the one real difference is consent: Mozilla requires
 * opt-in collection to go through Firefox's own permission prompt, so there a Yes counts only
 * once Firefox has granted it too.
 */

async function load(firefox: boolean) {
  vi.resetModules();
  vi.stubEnv("FIREFOX", String(firefox));
  return import("@/shared/browser");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("naming the browser", () => {
  it("says Chrome by default", async () => {
    const b = await load(false);
    expect(b.browserName()).toBe("Chrome");
    expect(b.siteAccessHint()).toContain("chrome://extensions");
  });

  it("recognises Edge from the same build, both ways Edge identifies itself", async () => {
    const b = await load(false);
    vi.stubGlobal("navigator", {
      userAgent: "",
      userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }] },
    });
    expect(b.browserName()).toBe("Edge");
    expect(b.siteAccessHint()).toContain("edge://extensions");

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/140.0 Safari/537.36 Edg/140.0",
    });
    expect(b.browserName()).toBe("Edge");
  });

  it("says Firefox, and points at about:addons, in the Firefox build", async () => {
    const b = await load(true);
    expect(b.browserName()).toBe("Firefox");
    expect(b.siteAccessHint()).toContain("about:addons");
  });
});

describe("Firefox's own consent", () => {
  const stubPermissions = (granted: boolean) => {
    const permissions = {
      request: vi.fn(async () => granted),
      remove: vi.fn(async () => true),
      contains: vi.fn(async () => granted),
    };
    vi.stubGlobal("chrome", { permissions });
    return permissions;
  };

  it("asks Firefox for exactly the three declared categories", async () => {
    const b = await load(true);
    const p = stubPermissions(true);
    expect(await b.requestSharingPermission()).toBe(true);
    expect(p.request).toHaveBeenCalledWith({
      data_collection: ["browsingActivity", "websiteContent", "websiteActivity"],
    });
  });

  it("reports a declined Firefox prompt as a no", async () => {
    const b = await load(true);
    stubPermissions(false);
    expect(await b.requestSharingPermission()).toBe(false);
    expect(await b.hasSharingPermission()).toBe(false);
  });

  it("gives the permission back on a no, so about:addons agrees with Settings", async () => {
    const b = await load(true);
    const p = stubPermissions(true);
    await b.releaseSharingPermission();
    expect(p.remove).toHaveBeenCalledWith({ data_collection: [...b.DATA_COLLECTION] });
  });

  it("asks nothing of Chrome and Edge, which have no such prompt", async () => {
    const b = await load(false);
    const p = stubPermissions(false);
    expect(await b.requestSharingPermission()).toBe(true);
    expect(await b.hasSharingPermission()).toBe(true);
    await b.releaseSharingPermission();
    expect(p.request).not.toHaveBeenCalled();
    expect(p.remove).not.toHaveBeenCalled();
  });

  it("notices a change to the sharing permission made in about:addons, and only that", async () => {
    const b = await load(true);
    expect(b.touchesSharing({ data_collection: ["websiteActivity"] })).toBe(true);
    expect(b.touchesSharing({ origins: ["https://*/*"] })).toBe(false);
    expect(b.touchesSharing({ data_collection: ["technicalAndInteraction"] })).toBe(false);
  });
});

describe("the per-browser manifest", () => {
  const manifestFor = async (browser: string) => {
    const config = (await import("../../wxt.config")).default as {
      manifest: (env: { browser: string }) => Record<string, unknown>;
    };
    return config.manifest({ browser });
  };

  it("gives Firefox a fixed id, and declares the reports as optional collection", async () => {
    const { DATA_COLLECTION } = await load(true);
    const gecko = ((await manifestFor("firefox")).browser_specific_settings as never)["gecko"] as {
      id: string;
      strict_min_version: string;
      data_collection_permissions: { required: string[]; optional: string[] };
    };
    // Changing the id after the first upload makes every installed copy an orphan.
    expect(gecko.id).toBe("pensa@viditchhajed");
    expect(gecko.data_collection_permissions.required).toEqual(["none"]);
    // What the manifest declares and what the code asks for are one list.
    expect(gecko.data_collection_permissions.optional).toEqual([...DATA_COLLECTION]);
    // The first Firefox with the built-in consent prompt.
    expect(Number.parseFloat(gecko.strict_min_version)).toBeGreaterThanOrEqual(140);
  });

  it("keeps Firefox settings out of the Chrome and Edge manifest", async () => {
    expect((await manifestFor("chrome")).browser_specific_settings).toBeUndefined();
  });
});
