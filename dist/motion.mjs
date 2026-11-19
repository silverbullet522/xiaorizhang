export const allowsMotion = matchMedia('(prefers-reduced-motion: no-preference)')
const active = new Map()

export function playMotion(node, keyframes, duration = 180) {
  if (!allowsMotion.matches || !node?.animate) return null
  active.get(node)?.cancel()
  const animation = node.animate(keyframes, { duration, easing: 'cubic-bezier(.2, .7, .3, 1)' })
  active.set(node, animation)
  const release = () => {
    if (active.get(node) === animation) active.delete(node)
  }
  animation.finished.then(release, release)
  return animation
}

allowsMotion.addEventListener?.('change', () => {
  if (!allowsMotion.matches) for (const animation of active.values()) animation.cancel()
})

export function readMeters(root) {
  if (!allowsMotion.matches) return null
  const values = new Map()
  for (const meter of root.querySelectorAll('[data-meter]')) {
    const axis = meter.dataset.axis === 'y' ? 'height' : 'width'
    const full = meter.parentElement.getBoundingClientRect()[axis]
    if (full) values.set(meter.dataset.meter, meter.getBoundingClientRect()[axis] / full)
  }
  return values
}

export function transitionMeters(root, previous) {
  if (!previous?.size || !allowsMotion.matches) return
  for (const meter of root.querySelectorAll('[data-meter]')) {
    const from = previous.get(meter.dataset.meter) ?? 0
    const to = Number(meter.dataset.level)
    if (Math.abs(to - from) < .004 || !meter.getClientRects().length) continue
    const scale = meter.dataset.axis === 'y' ? 'scaleY' : 'scaleX'
    playMotion(meter, [{ transform: scale + '(' + from + ')' }, { transform: scale + '(' + to + ')' }], 210)
  }
}

export function animateCategory(tile, panel) {
  if (!allowsMotion.matches) return
  const glyph = tile?.querySelector('.category-icon')
  if (glyph) {
    const style = getComputedStyle(glyph)
    playMotion(glyph, [
      { color: style.getPropertyValue('--icon-inactive').trim(), transform: 'scale(.94)' },
      { color: style.color, transform: 'scale(1.04)', offset: .65 },
      { color: style.color, transform: 'scale(1)' }
    ], 180)
  }
  playMotion(panel, [
    { clipPath: 'inset(0 0 100% 0)', opacity: .5, transform: 'translateY(-4px)' },
    { clipPath: 'inset(0)', opacity: 1, transform: 'translateY(0)' }
  ])
}
