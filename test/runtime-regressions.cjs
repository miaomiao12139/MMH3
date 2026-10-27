const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const { resolveRuntimeRoot, relocateStoredPaths, cancelPrompt, isInside } = require("../src/runtime.cjs");
const { createPreferenceStore } = require("../src/preferences.cjs");

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "h3-regression-"));
  const root = path.join(fixture, "new disk", "App");
  const original = path.join(fixture, "old disk", "App");
  fs.mkdirSync(path.join(root, "user", "assets"), { recursive: true });
  const writeText = (file, text) => fs.writeFileSync(file, text);
  try {
    const expectedFiles = new Set([path.join(root, "python", "python.exe"), path.join(root, "ComfyUI", "main.py")]);
    for (const portableDir of [root, path.dirname(root), path.join(path.dirname(root), "Source", "electron-studio", "release")]) {
      assert.equal(resolveRuntimeRoot({ portableDir, executableDir: path.join(fixture, "temp", "extract"), exists: (p) => expectedFiles.has(p) }), root);
    }
    const oldMedia = path.join(original, "user", "queue-input", "job", "image.png");
    const migrated = relocateStoredPaths({ media: [oldMedia], outputPath: path.join(original, "output", "video.mp4"), prompt: oldMedia, referenceAssets: [{ assetId: "stable-id", filePath: oldMedia, fileUrl: pathToFileURL(oldMedia).href }] }, root, original);
    assert.equal(migrated.media[0], path.join(root, "user", "queue-input", "job", "image.png"));
    assert.equal(migrated.referenceAssets[0].assetId, "stable-id");
    assert.equal(fileURLToPath(migrated.referenceAssets[0].fileUrl), migrated.media[0]);
    assert.equal(migrated.prompt, oldMedia);
    assert.equal(relocateStoredPaths({ path: oldMedia }, root).path, migrated.media[0]);

    let executing = "video-running";
    let pending = ["cutout-pending"];
    const interrupted = [];
    const request = async (method, route, body) => {
      if (route === "/queue") pending = pending.filter((id) => !body.delete.includes(id));
      if (route === "/interrupt") {
        assert.ok(body.prompt_id, "Never issue an unscoped interrupt");
        if (body.prompt_id === executing) interrupted.push(executing);
      }
    };
    await cancelPrompt(request, "cutout-pending");
    assert.deepEqual(pending, []);
    assert.deepEqual(interrupted, []);
    await cancelPrompt(request, "video-running");
    assert.deepEqual(interrupted, ["video-running"]);
    executing = "cutout-running";
    await cancelPrompt(request, "already-completed-video");
    assert.equal(interrupted.length, 1);

    const preferences = createPreferenceStore(() => root, writeText);
    preferences.load({ "minimax-h3-prompt-presets-v1": '[{"id":"keep","text":"Keep my preset"}]', unrelated: "excluded" });
    const source = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
    const assetFunctions = source.slice(source.indexOf("function assetLibraryDir("), source.indexOf("function normalizeReferenceAsset("));
    const context = { fs, path, crypto, pathToFileURL, fileURLToPath, rootDir: () => root, preferences, stagedAssetTimes: new Map(), readQueueJobs: () => [], activeCutoutBatch: null, isWithin: isInside, imageAssetPattern: /\.(png|jpe?g|webp|avif)$/i };
    const assets = vm.runInNewContext(assetFunctions + ";({stageAssetFile,pruneUnusedAssets})", context);
    const external = path.join(fixture, "original-image.png");
    fs.writeFileSync(external, "first-image");
    const first = assets.stageAssetFile(external);
    const same = assets.stageAssetFile(external);
    assert.equal(first.path, same.path);
    assert.equal(fs.readdirSync(path.join(root, "user", "assets")).length, 1);
    preferences.save("minimax-h3-workflow-drafts-v1", JSON.stringify({ cutout: { files: [external], previews: [pathToFileURL(external).href] } }));
    assert.equal(JSON.parse(preferences.values()["minimax-h3-workflow-drafts-v1"]).cutout.files[0], first.path);
    assert.equal(assets.pruneUnusedAssets([first.path]).removed, 0, "Keep draft inputs when clearing library");
    preferences.save("minimax-h3-workflow-drafts-v1", "{}");
    assert.equal(assets.pruneUnusedAssets([first.path]).removed, 1);
    assert.ok(fs.existsSync(external), "Original image must survive cleanup");
    preferences.flush();
    const otherRoot = path.join(fixture, "another computer", "App");
    fs.mkdirSync(path.join(otherRoot, "user"), { recursive: true });
    preferences.save("minimax-h3-video-favorites-v1", JSON.stringify([path.join(root, "output", "favourite.mp4")]));
    preferences.flush();
    fs.copyFileSync(path.join(root, "user", "studio-preferences.json"), path.join(otherRoot, "user", "studio-preferences.json"));
    const copied = createPreferenceStore(() => otherRoot, writeText);
    const loaded = copied.load({ "minimax-h3-prompt-presets-v1": "[]" });
    assert.equal(JSON.parse(loaded["minimax-h3-prompt-presets-v1"])[0].text, "Keep my preset");
    assert.equal(JSON.parse(loaded["minimax-h3-video-favorites-v1"])[0], path.join(otherRoot, "output", "favourite.mp4"));
    copied.flush();

    if (process.platform === "win32") {
      const installation = path.join(fixture, "更新 & [便携] space");
      const updateDir = path.join(installation, ".updates");
      fs.mkdirSync(updateDir, { recursive: true });
      const target = path.join(installation, "MiniMax H3 Studio.exe");
      const download = path.join(updateDir, "MiniMax H3 Studio.exe.download");
      const models = path.join(installation, "model.safetensors");
      fs.writeFileSync(target, "old-app"); fs.writeFileSync(download, "new-app"); fs.writeFileSync(models, "untouched-model");
      const script = path.resolve(__dirname, "../src/update-runner.ps1");
      const shell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const hash = crypto.createHash("sha256").update("new-app").digest("hex");
      const update = (checksum) => spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Target", target, "-Download", download, "-ExpectedHash", checksum, "-NoRestart"], { encoding: "utf8", windowsHide: true, timeout: 15000 });
      assert.equal(update("wrong-hash").status, 1);
      assert.equal(fs.readFileSync(target, "utf8"), "old-app");
      const locker = spawn(shell, ["-NoProfile", "-Command", "$f=[IO.File]::Open($env:H3_TEST_DOWNLOAD,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); Write-Output 'locked'; [Console]::ReadLine() | Out-Null; $f.Dispose()"], { env: { ...process.env, H3_TEST_DOWNLOAD: download }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      await new Promise((resolve, reject) => { locker.stdout.once("data", resolve); locker.once("error", reject); });
      try {
        assert.equal(update(hash).status, 1);
        assert.equal(fs.readFileSync(target, "utf8"), "old-app", "Restore the original if installing fails");
      } finally { locker.stdin.end("\n"); await new Promise((resolve) => locker.once("exit", resolve)); }
      const result = update(hash);
      assert.equal(result.status, 0, result.stderr + fs.readFileSync(path.join(updateDir, "result.json"), "utf8"));
      assert.equal(fs.readFileSync(target, "utf8"), "new-app");
      assert.equal(fs.readFileSync(models, "utf8"), "untouched-model");
      assert.equal(fs.existsSync(path.join(updateDir, "MiniMax H3 Studio.exe.previous")), false);
    }
    console.log("Runtime regressions passed: root discovery, migration, task cancellation, portable preferences, asset cleanup, updater and rollback.");
  } finally {
    assert.ok(isInside(os.tmpdir(), fixture) && path.basename(fixture).startsWith("h3-regression-"));
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
