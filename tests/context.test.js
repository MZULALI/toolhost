import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../src/worker/context.js";
import { withTempDir } from "./helpers.js";

test("resolveInside accepts paths inside the workspace, existing or not", () =>
  withTempDir(async (dir) => {
    const ws = path.join(dir, "ws");
    await fs.mkdir(path.join(ws, "sub"), { recursive: true });
    const real = await fs.realpath(ws);
    assert.equal(await resolveInside(ws, "sub"), path.join(real, "sub"));
    assert.equal(await resolveInside(ws, "sub/new/deep.txt"), path.join(real, "sub", "new", "deep.txt"));
    assert.equal(await resolveInside(ws, "."), real);
    assert.equal(await resolveInside(ws, "sub/../sub/x"), path.join(real, "sub", "x"));
  }));

test("resolveInside rejects lexical escapes and bad input", () =>
  withTempDir(async (dir) => {
    const ws = path.join(dir, "ws");
    await fs.mkdir(ws);
    for (const bad of ["..", "../x", "sub/../../x", "/etc/passwd", "....//x/../../../y"]) {
      await assert.rejects(resolveInside(ws, bad), (error) => error.code === "path_outside_workspace", bad);
    }
    await assert.rejects(resolveInside(ws, "a\0b"), (error) => error.code === "invalid_path");
    await assert.rejects(resolveInside(ws, 42), (error) => error.code === "invalid_path");
  }));

test("resolveInside follows symlinks and rejects ones that lead out", () =>
  withTempDir(async (dir) => {
    const ws = path.join(dir, "ws");
    const outside = path.join(dir, "outside");
    await fs.mkdir(path.join(ws, "in"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(ws, "link"));
    await fs.symlink(path.join(outside, "secret.txt"), path.join(ws, "file-link"));
    await fs.symlink(path.join(ws, "in"), path.join(ws, "in-link"));

    await assert.rejects(resolveInside(ws, "link/secret.txt"), (error) => error.code === "path_outside_workspace");
    await assert.rejects(resolveInside(ws, "link/new-file.txt"), (error) => error.code === "path_outside_workspace", "writes through a link are rejected too");
    await assert.rejects(resolveInside(ws, "file-link"), (error) => error.code === "path_outside_workspace");
    assert.equal(await resolveInside(ws, "in-link/x.txt"), path.join(await fs.realpath(ws), "in", "x.txt"), "links that stay inside are fine");
  }));
