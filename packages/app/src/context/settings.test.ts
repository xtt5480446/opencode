import { describe, expect, test } from "bun:test"
import {
  formatOldInterfaceSunset,
  hasMeaningfulLayoutData,
  layoutTransitionState,
  maximumSunsetTimeout,
  migrateSettings,
  newLayoutDesignsDefault,
  nextSunsetCheckDelay,
  resolveLayoutTransitionClassification,
  resolveNewLayoutDesigns,
} from "./settings"

describe("layout transition", () => {
  test("blank profiles default to the new layout", () => {
    expect(newLayoutDesignsDefault).toBe(true)
    expect(
      hasMeaningfulLayoutData({ settings: false, server: false, wsl: false, projects: false, sessions: false }),
    ).toBe(false)
  })

  test("recognizes each source of meaningful prior use", () => {
    const blank = { settings: false, server: false, wsl: false, projects: false, sessions: false }
    expect(hasMeaningfulLayoutData({ ...blank, settings: true })).toBe(true)
    expect(hasMeaningfulLayoutData({ ...blank, server: true })).toBe(true)
    expect(hasMeaningfulLayoutData({ ...blank, wsl: true })).toBe(true)
    expect(hasMeaningfulLayoutData({ ...blank, projects: true })).toBe(true)
    expect(hasMeaningfulLayoutData({ ...blank, sessions: true })).toBe(true)
  })

  test("allows late evidence to promote but never downgrade a cohort", () => {
    expect(resolveLayoutTransitionClassification(undefined, false)).toBe(false)
    expect(resolveLayoutTransitionClassification(false, true)).toBe(true)
    expect(resolveLayoutTransitionClassification(true, false)).toBe(true)
  })

  test("formats the English deadline with an ordinal before sunset", () => {
    const sunset = new Date(2026, 7, 6)
    expect(formatOldInterfaceSunset("en-US", true, sunset)).toBe("August 6th")
    expect(formatOldInterfaceSunset("en-US", false, sunset)).toBe("August 6")
  })

  test("hides the transition until a sunset is scheduled", () => {
    expect(layoutTransitionState(false, true, false, false)).toEqual({ available: false, notice: false })
    expect(formatOldInterfaceSunset("en-US")).toBe("")
  })

  test("existing profiles can switch before sunset", () => {
    expect(migrateSettings({ general: { newLayoutDesigns: false } })).toEqual({
      general: { newLayoutDesigns: false, layoutTransitionSettingsPresent: true },
    })
    expect(layoutTransitionState(true, true, false, false)).toEqual({ available: true, notice: false })
  })

  test("preserves explicit and default layout preferences", () => {
    expect(resolveNewLayoutDesigns(false, false, true)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, false)).toBe(false)
    expect(resolveNewLayoutDesigns(false, undefined, true)).toBe(true)
  })

  test("sunset replaces the toggle with a dismissible notice", () => {
    expect(layoutTransitionState(true, true, true, false)).toEqual({ available: false, notice: true })
    expect(layoutTransitionState(true, true, true, true)).toEqual({ available: false, notice: false })
    expect(resolveNewLayoutDesigns(true, false)).toBe(true)
  })

  test("caps checks for sunsets beyond the browser timeout limit", () => {
    expect(nextSunsetCheckDelay(maximumSunsetTimeout + 1_000, 0)).toBe(maximumSunsetTimeout)
    expect(nextSunsetCheckDelay(10_000, 9_000)).toBe(1_000)
    expect(nextSunsetCheckDelay(9_000, 10_000)).toBe(0)
  })

  test("migration does not reclassify fresh profiles", () => {
    const settings = { general: { newLayoutDesigns: true, layoutTransitionEligible: false } }
    expect(migrateSettings(settings)).toBe(settings)
  })
})
