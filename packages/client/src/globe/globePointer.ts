/** Match the click tolerance, and disqualify a drag even if it ends at its start. */
const DRAG_RADIUS_PX = 6;
const MAX_CLICK_MS = 600;

/** Detect single-pointer rotation, not OrbitControls' wheel, pinch, or dolly gestures. */
export class GlobePointer {
  private readonly pointers = new Set<number>();
  private gesture: { id: number; x: number; y: number; t: number; dragged: boolean } | null = null;

  constructor(
    private readonly element: HTMLElement,
    private readonly onDrag: () => void,
    private readonly onClick: (event: PointerEvent) => void,
  ) {
    element.addEventListener('pointerdown', this.down);
    element.ownerDocument.addEventListener('pointermove', this.move, true);
    element.ownerDocument.addEventListener('pointerup', this.up, true);
    element.ownerDocument.addEventListener('pointercancel', this.cancel, true);
  }

  private readonly down = (e: PointerEvent): void => {
    this.pointers.add(e.pointerId);
    // Default OrbitControls only rotate with one finger or an unmodified left button.
    this.gesture = this.pointers.size === 1 && e.isPrimary && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey
      ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dragged: false }
      : null;
  };

  private readonly move = (e: PointerEvent): void => {
    const g = this.gesture;
    if (!g || g.id !== e.pointerId || g.dragged) return;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) <= DRAG_RADIUS_PX) return;
    g.dragged = true;
    this.onDrag();
  };

  private readonly up = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    const g = this.gesture;
    if (!g || g.id !== e.pointerId) return;
    this.move(e);
    this.gesture = null;
    if (!g.dragged && performance.now() - g.t <= MAX_CLICK_MS) this.onClick(e);
  };

  private readonly cancel = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.gesture?.id === e.pointerId) this.gesture = null;
  };

  dispose(): void {
    this.element.removeEventListener('pointerdown', this.down);
    this.element.ownerDocument.removeEventListener('pointermove', this.move, true);
    this.element.ownerDocument.removeEventListener('pointerup', this.up, true);
    this.element.ownerDocument.removeEventListener('pointercancel', this.cancel, true);
  }
}
