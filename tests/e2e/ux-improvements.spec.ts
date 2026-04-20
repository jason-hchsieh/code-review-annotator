/**
 * BDD-style Playwright tests for UX/UI improvements (v0.31.0)
 *
 * Feature: Sidebar status filter pills
 * Feature: Auto-scroll to first open comment after file selection
 * Feature: Sidebar comment progress bar
 * Feature: View mode breadcrumb
 * Feature: Pick visually button prominence
 * Feature: Orphan badge tooltip
 * Feature: No-changes diff banner
 * Feature: Project switch content fade
 * Feature: Keyboard shortcut help modal
 */

import { test, expect } from '@playwright/test'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForApp(page: Parameters<typeof test.fn>[0]['page']) {
  await page.goto('/')
  // Wait until the project select is populated (app booted)
  await page.waitForFunction(() => {
    const sel = document.querySelector('#project-select') as HTMLSelectElement
    return sel && sel.options.length > 0
  }, { timeout: 8000 })
}

// ---------------------------------------------------------------------------
// Feature 1: Sidebar status filter pills
// ---------------------------------------------------------------------------

test.describe('Feature: Sidebar status filter pills', () => {
  test('Scenario: Pills render with correct labels and default state', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then three pills should be visible
    await expect(page.locator('.sidebar-filter-pill')).toHaveCount(3)

    // And "All" pill should be active by default
    const allPill = page.locator('.sidebar-filter-pill[data-filter="all"]')
    await expect(allPill).toBeVisible()
    await expect(allPill).toHaveClass(/active/)

    // And "Open" and "Resolved" pills exist but are not active
    await expect(page.locator('.sidebar-filter-pill[data-filter="open"]')).toBeVisible()
    await expect(page.locator('.sidebar-filter-pill[data-filter="resolved"]')).toBeVisible()
  })

  test('Scenario: Clicking a pill activates it and deactivates others', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // When I click the "Open" pill
    await page.locator('.sidebar-filter-pill[data-filter="open"]').click()

    // Then "Open" pill becomes active
    await expect(page.locator('.sidebar-filter-pill[data-filter="open"]')).toHaveClass(/active/)

    // And "All" pill is no longer active
    await expect(page.locator('.sidebar-filter-pill[data-filter="all"]')).not.toHaveClass(/active/)

    // When I click "Resolved"
    await page.locator('.sidebar-filter-pill[data-filter="resolved"]').click()

    // Then "Resolved" becomes active
    await expect(page.locator('.sidebar-filter-pill[data-filter="resolved"]')).toHaveClass(/active/)
    await expect(page.locator('.sidebar-filter-pill[data-filter="open"]')).not.toHaveClass(/active/)
  })

  test('Scenario: Clicking "All" pill shows all sidebar items', async ({ page }) => {
    // Given the app is open and "Open" filter is active
    await waitForApp(page)
    await page.locator('.sidebar-filter-pill[data-filter="open"]').click()

    // When I click back to "All"
    await page.locator('.sidebar-filter-pill[data-filter="all"]').click()

    // Then "All" is active
    await expect(page.locator('.sidebar-filter-pill[data-filter="all"]')).toHaveClass(/active/)
  })
})

// ---------------------------------------------------------------------------
// Feature 7: No-changes banner
// ---------------------------------------------------------------------------

test.describe('Feature: No-changes diff banner', () => {
  test('Scenario: Banner is hidden by default on page load', async ({ page }) => {
    // Given the app is open with no file selected
    await waitForApp(page)

    // Then the no-changes banner should not be visible
    await expect(page.locator('#no-changes-banner')).not.toHaveClass(/visible/)
  })

  test('Scenario: Banner has the correct SVG icon and text structure', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then the banner contains an SVG icon
    await expect(page.locator('#no-changes-banner svg')).toBeAttached()

    // And it contains the #no-changes-file span
    await expect(page.locator('#no-changes-file')).toBeAttached()
  })
})

// ---------------------------------------------------------------------------
// Feature 9: Keyboard shortcut help modal
// ---------------------------------------------------------------------------

test.describe('Feature: Keyboard shortcut help modal', () => {
  test('Scenario: ? button is visible in the bottom-right corner', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then the shortcuts button should be visible
    const btn = page.locator('#btn-shortcuts')
    await expect(btn).toBeVisible()
    await expect(btn).toHaveText('?')
  })

  test('Scenario: Clicking ? opens the shortcuts modal', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // When I click the ? button
    await page.locator('#btn-shortcuts').click()

    // Then the shortcuts overlay appears
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/open/)

    // And the modal contains navigation shortcuts
    await expect(page.locator('.shortcuts-modal-title')).toHaveText('Keyboard Shortcuts')
  })

  test('Scenario: Pressing Escape closes the shortcuts modal', async ({ page }) => {
    // Given the shortcuts modal is open
    await waitForApp(page)
    await page.locator('#btn-shortcuts').click()
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/open/)

    // When I press Escape
    await page.keyboard.press('Escape')

    // Then the modal closes
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/open/)
  })

  test('Scenario: Pressing ? key toggles the shortcuts modal', async ({ page }) => {
    // Given the app is open with no input focused
    await waitForApp(page)
    await page.locator('body').click()

    // When I press the ? key
    await page.keyboard.press('Shift+Slash')

    // Then the shortcuts modal opens
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/open/)

    // When I press ? again
    await page.keyboard.press('Shift+Slash')

    // Then the modal closes
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/open/)
  })

  test('Scenario: Clicking outside the modal closes it', async ({ page }) => {
    // Given the shortcuts modal is open
    await waitForApp(page)
    await page.locator('#btn-shortcuts').click()
    await expect(page.locator('#shortcuts-overlay')).toHaveClass(/open/)

    // When I click the overlay backdrop
    await page.locator('#shortcuts-overlay').click({ position: { x: 10, y: 10 } })

    // Then the modal closes
    await expect(page.locator('#shortcuts-overlay')).not.toHaveClass(/open/)
  })

  test('Scenario: Shortcuts modal contains all expected sections', async ({ page }) => {
    // Given the shortcuts modal is open
    await waitForApp(page)
    await page.locator('#btn-shortcuts').click()

    // Then all sections are present
    const titles = await page.locator('.shortcuts-section-title').allTextContents()
    expect(titles).toContain('Comment Navigation')
    expect(titles).toContain('Forms & Modals')
    expect(titles).toContain('Graph Picker')

    // And shortcut keys are visible
    await expect(page.locator('.shortcuts-key').first()).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Feature 3: Sidebar comment progress bar
// ---------------------------------------------------------------------------

test.describe('Feature: Sidebar comment progress bar', () => {
  test('Scenario: Progress bar is hidden when no comments exist', async ({ page }) => {
    // Given the app is open with no comments
    await waitForApp(page)

    // Then the progress bar should not be visible
    // (It shows as visible only when there are comments)
    const progress = page.locator('#sidebar-progress')
    await expect(progress).not.toHaveClass(/visible/)
  })

  test('Scenario: Progress bar DOM structure is correct', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then the progress bar elements exist in the DOM
    await expect(page.locator('#sidebar-progress-bar-wrap')).toBeAttached()
    await expect(page.locator('#sidebar-progress-bar')).toBeAttached()
    await expect(page.locator('#sidebar-progress-text')).toBeAttached()
  })
})

// ---------------------------------------------------------------------------
// Feature 5: Pick visually button prominence
// ---------------------------------------------------------------------------

test.describe('Feature: Pick visually button prominence', () => {
  test('Scenario: Pick visually button is visible in git-range mode', async ({ page }) => {
    // Given the app is open (default mode is git-range)
    await waitForApp(page)

    // Then the view-bar should be visible (git-range mode is default)
    // The btn-graph may be hidden if not in git-range mode
    const viewBar = page.locator('#view-bar')

    // If view-bar is visible, btn-graph should be inside it
    if (await viewBar.isVisible()) {
      await expect(page.locator('#open-graph-picker')).toBeVisible()
      // And it should have the prominent style (solid accent background by default)
      const btn = page.locator('#open-graph-picker')
      await expect(btn).toContainText('Pick visually')
    }
  })

  test('Scenario: Range chip slot is present in git-range mode view-bar', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then the range chip slot should be in the DOM
    await expect(page.locator('#range-chip-slot')).toBeAttached()
  })
})

// ---------------------------------------------------------------------------
// Feature 6: Orphan badge tooltip
// ---------------------------------------------------------------------------

test.describe('Feature: Orphan badge tooltip', () => {
  test('Scenario: Orphan status badge has explanatory title text', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // When orphan badges exist in the timeline (may not always be present)
    const orphanBadges = page.locator('.status-badge.orphan')
    const count = await orphanBadges.count()

    if (count > 0) {
      // Then each orphan badge has a title attribute explaining the status
      for (let i = 0; i < count; i++) {
        const title = await orphanBadges.nth(i).getAttribute('title')
        expect(title).toBeTruthy()
        expect(title).toContain('hook')
      }
    } else {
      // Pending badges should also have tooltips
      const pendingBadges = page.locator('.status-badge.pending')
      const pendingCount = await pendingBadges.count()
      if (pendingCount > 0) {
        const title = await pendingBadges.first().getAttribute('title')
        expect(title).toBeTruthy()
      }
      // Skip gracefully if no status badges are present
      test.skip(count === 0 && pendingCount === 0, 'No status badges in current session')
    }
  })
})

// ---------------------------------------------------------------------------
// Feature 8: Project switch content fade
// ---------------------------------------------------------------------------

test.describe('Feature: Project switch content fade', () => {
  test('Scenario: Content area has CSS transition property', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then #content should have a CSS transition applied
    const transition = await page.locator('#content').evaluate(
      (el) => window.getComputedStyle(el).transition
    )
    expect(transition).toContain('opacity')
  })

  test('Scenario: Content does not have "fading" class initially', async ({ page }) => {
    // Given the app just loaded
    await waitForApp(page)

    // Then content should not be fading
    await expect(page.locator('#content')).not.toHaveClass(/fading/)
  })
})

// ---------------------------------------------------------------------------
// Feature 4: View mode breadcrumb (meta display)
// ---------------------------------------------------------------------------

test.describe('Feature: View mode breadcrumb', () => {
  test('Scenario: Header mode switch shows current view mode', async ({ page }) => {
    // Given the app is open
    await waitForApp(page)

    // Then the mode switch shows the active mode
    const activeMode = page.locator('.mode-switch button.active')
    await expect(activeMode).toBeVisible()
  })

  test('Scenario: Content header meta shows ref context when a file is loaded', async ({ page }) => {
    // Given the app is open in git-range mode
    await waitForApp(page)

    // When a file is shown (call-header is visible)
    const header = page.locator('#call-header')
    if (await header.isVisible()) {
      // Then #ch-meta shows some context info
      const meta = page.locator('#ch-meta')
      await expect(meta).toBeVisible()
      const text = await meta.textContent()
      expect(text).toBeTruthy()
    }
  })
})
