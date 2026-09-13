import assert from "node:assert/strict"
import test from "node:test"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
} from "node:fs"
import {
  tmpdir,
} from "node:os"
import {
  join,
} from "node:path"

import {
  assertSafeRecursiveTarget,
} from "../../installer/path-security.mjs"

function makeRoots() {
  const home =
    mkdtempSync(
      join(tmpdir(), "pathsec-home-"),
    )

  const dataHome =
    join(home, "data")

  mkdirSync(dataHome, { recursive: true })

  const appData =
    join(dataHome, "opencode-mcp-orchestrator")

  mkdirSync(appData, { recursive: true })

  return { home, dataHome, appData }
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

test("allows an existing real descendant and a not-yet-existing descendant", () => {
  const { home, dataHome, appData } = makeRoots()

  try {
    mkdirSync(join(appData, "current"), { recursive: true })

    assert.equal(
      assertSafeRecursiveTarget(join(appData, "current"), { home, dataHome, appData }),
      join(appData, "current"),
    )

    assert.equal(
      assertSafeRecursiveTarget(join(appData, "current", "not-yet", "leaf"), { home, dataHome, appData }),
      join(appData, "current", "not-yet", "leaf"),
    )
  } finally {
    cleanup(home)
  }
})

test("rejects an intermediate-parent symlink without following it", () => {
  const { home, dataHome, appData } = makeRoots()

  try {
    const outside =
      mkdtempSync(join(tmpdir(), "pathsec-out-"))

    try {
      symlinkSync(outside, join(appData, "mid"))

      assert.throws(
        () => assertSafeRecursiveTarget(join(appData, "mid", "leaf"), { home, dataHome, appData }),
        /refusing to operate on symlinked path/,
      )
    } finally {
      cleanup(outside)
    }
  } finally {
    cleanup(home)
  }
})

test("rejects a final-component symlink and a symlinked application directory", () => {
  const { home, dataHome, appData } = makeRoots()

  try {
    const outside =
      mkdtempSync(join(tmpdir(), "pathsec-out-"))

    try {
      mkdirSync(join(appData, "real"), { recursive: true })
      symlinkSync(join(appData, "real"), join(appData, "linked"))

      assert.throws(
        () => assertSafeRecursiveTarget(join(appData, "linked"), { home, dataHome, appData }),
        /refusing to operate on symlinked path/,
      )

      cleanup(appData)
      symlinkSync(outside, appData)

      assert.throws(
        () => assertSafeRecursiveTarget(join(appData, "anything"), { home, dataHome, appData }),
        /refusing to operate on symlinked/,
      )
    } finally {
      cleanup(outside)
    }
  } finally {
    cleanup(home)
  }
})

test("rejects a symlinked data-home root and an absent data root through a symlink", () => {
  const home =
    mkdtempSync(join(tmpdir(), "pathsec-home-"))

  try {
    const outside =
      mkdtempSync(join(tmpdir(), "pathsec-out-"))

    try {
      const dataHome = join(home, "data")
      mkdirSync(dataHome, { recursive: true })
      const appData = join(dataHome, "opencode-mcp-orchestrator")
      mkdirSync(appData, { recursive: true })

      const linkTarget = join(outside, "real-data")
      mkdirSync(linkTarget, { recursive: true })
      const linkedDataHome = join(home, "linked-data")
      symlinkSync(linkTarget, linkedDataHome)

      assert.throws(
        () => assertSafeRecursiveTarget(
          join(linkedDataHome, "opencode-mcp-orchestrator", "x"),
          { home, dataHome: linkedDataHome, appData: join(linkedDataHome, "opencode-mcp-orchestrator") },
        ),
        /refusing to operate on symlinked/,
      )

      const throughLink = join(home, "link")
      symlinkSync(outside, throughLink)
      const absentDataHome = join(throughLink, "absent-data")
      const absentAppData = join(absentDataHome, "opencode-mcp-orchestrator")

      assert.throws(
        () => assertSafeRecursiveTarget(join(absentAppData, "x"), { home, dataHome: absentDataHome, appData: absentAppData }),
        /refusing to operate on symlinked/,
      )
    } finally {
      cleanup(outside)
    }
  } finally {
    cleanup(home)
  }
})

test("rejects root, home, data-home, escapes, relative roots, and blank values", () => {
  const { home, dataHome, appData } = makeRoots()

  try {
    assert.throws(
      () => assertSafeRecursiveTarget("/", { home, dataHome, appData }),
      /refusing to operate/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget(home, { home, dataHome, appData }),
      /refusing to operate on home/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget(dataHome, { home, dataHome, appData }),
      /refusing to operate on data-home root/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget(join(home, "elsewhere"), { home, dataHome, appData }),
      /refusing to operate outside/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget(join(appData, "x"), { home: "", dataHome, appData }),
      /refusing to operate without resolved/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget(join(appData, "x"), { home: "relative/home", dataHome, appData }),
      /refusing to operate with non-absolute/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget("relative/target", { home, dataHome, appData }),
      /refusing to operate with non-absolute target/,
    )

    assert.throws(
      () => assertSafeRecursiveTarget("   ", { home, dataHome, appData }),
      /refusing to operate on empty path/,
    )
  } finally {
    cleanup(home)
  }
})
