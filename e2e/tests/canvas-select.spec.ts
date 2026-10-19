import { expect, test, tile } from '../fixtures/test.js'
import { cellPoint } from '../fixtures/board.js'
import { baseConfig, type ConfigSeed } from '../fixtures/seeds.js'

/** The clock at 0,0 (16 × 4), a pomodoro at 20,8 (8 × 6) and a second clock at 40,2 (8 × 4). */
function seed(): ConfigSeed {
  const c = baseConfig()
  c.widgets['pomodoro-1'] = { widgetId: 'pomodoro', showTitle: true, settings: {} }
  c.widgets['clock-2'] = { widgetId: 'clock', showTitle: true, settings: {} }
  c.screens[0].pages[0].items.push(
    { instanceId: 'pomodoro-1', x: 20, y: 8, w: 8, h: 6 },
    { instanceId: 'clock-2', x: 40, y: 2, w: 8, h: 4 },
  )
  return c
}
test.use({ seed: seed() })

const guides = (page: import('@playwright/test').Page) => page.locator('[data-test="guide"]')

test('alignment guides show while a tile is dragged into line, and go on release', async ({ page, openAdmin }) => {
  await openAdmin()
  await expect(guides(page)).toHaveCount(0)
  // Grab the clock and bring its left edge to the pomodoro's (x = 20), its top at 7: nothing else lines up.
  const a = await cellPoint(page, 3.25, 1.25)
  const b = await cellPoint(page, 23.25, 8.25)
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: 8 })
  await expect(guides(page)).not.toHaveCount(0)
  await expect(page.locator('[data-test="guide"].x')).not.toHaveCount(0)
  await page.mouse.up()
  await expect(guides(page)).toHaveCount(0)
})

test('an arrow key that brings a tile into line flashes its guides', async ({ page, openAdmin }) => {
  await openAdmin()
  await tile(page, 'clock-2').click()
  // Six steps down put clock-2's top at 8, in line with the pomodoro's.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowDown')
  await expect(page.locator('[data-test="guide"].y')).not.toHaveCount(0)
  await expect(guides(page)).toHaveCount(0, { timeout: 3000 })
})
