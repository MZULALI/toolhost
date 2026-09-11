import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveInside } from "../src/worker/context.ts";
import { withTempDir } from "./helpers.ts";

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
      await assert.rejects(resolveInside(ws, bad), (error: any) => error.code === "path_outside_workspace", bad);
    }
    await assert.rejects(resolveInside(ws, "a\0b"), (error: any) => error.code === "invalid_path");
    await assert.rejects(resolveInside(ws, 42), (error: any) => error.code === "invalid_path");
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

    await assert.rejects(resolveInside(ws, "link/secret.txt"), (error: any) => error.code === "path_outside_workspace");
    await assert.rejects(resolveInside(ws, "link/new-file.txt"), (error: any) => error.code === "path_outside_workspace", "writes through a link are rejected too");
    await assert.rejects(resolveInside(ws, "file-link"), (error: any) => error.code === "path_outside_workspace");
    assert.equal(await resolveInside(ws, "in-link/x.txt"), path.join(await fs.realpath(ws), "in", "x.txt"), "links that stay inside are fine");
  }));

test("resolveInside rejects dangling symlinks, so a write cannot create a file elsewhere", () =>
  withTempDir(async (dir) => {
    const ws = path.join(dir, "ws");
    const outside = path.join(dir, "outside");
    await fs.mkdir(ws);
    await fs.mkdir(outside);
    await fs.symlink(path.join(outside, "planted.txt"), path.join(ws, "dangling"));
    await fs.symlink(path.join(outside, "missing-dir"), path.join(ws, "dangling-dir"));
    await assert.rejects(resolveInside(ws, "dangling"), (error: any) => error.code === "path_outside_workspace");
    await assert.rejects(resolveInside(ws, "dangling-dir/child.txt"), (error: any) => error.code === "path_outside_workspace");
    await fs.symlink(path.join(ws, "not-yet"), path.join(ws, "dangling-inside"));
    await assert.rejects(resolveInside(ws, "dangling-inside"), (error: any) => error.code === "path_outside_workspace", "even an inside-pointing dangling link is refused: its target is not checkable");
  }));

test("resolveInside works when the workspace itself is a symlink", () =>
  withTempDir(async (dir) => {
    const real = path.join(dir, "real-ws");
    const link = path.join(dir, "link-ws");
    await fs.mkdir(real);
    await fs.symlink(real, link);
    const realResolved = await fs.realpath(real);
    assert.equal(await resolveInside(link, "a.txt"), path.join(realResolved, "a.txt"));
    assert.equal(await resolveInside(link, realResolved + "/b.txt"), path.join(realResolved, "b.txt"), "absolute real paths inside are accepted");
  }));
