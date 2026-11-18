let scrollLockCount = 0;
let restorePageScroll: (() => void) | undefined;

export function lockPageScroll() {
  if (scrollLockCount === 0) {
    const body = document.body;
    const root = document.documentElement;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const previousBodyStyle = {
      left: body.style.left,
      overflow: body.style.overflow,
      paddingRight: body.style.paddingRight,
      position: body.style.position,
      right: body.style.right,
      top: body.style.top,
      width: body.style.width,
    };
    const previousRootOverflow = root.style.overflow;
    const scrollbarWidth = window.innerWidth - root.clientWidth;

    if (scrollbarWidth > 0) {
      body.style.paddingRight = `${parseFloat(getComputedStyle(body).paddingRight) + scrollbarWidth}px`;
    }

    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "auto";
    body.style.overflow = "hidden";
    root.style.overflow = "hidden";

    restorePageScroll = () => {
      Object.assign(body.style, previousBodyStyle);
      root.style.overflow = previousRootOverflow;
      window.scrollTo({ left: scrollX, top: scrollY, behavior: "instant" });
    };
  }

  scrollLockCount += 1;
  let released = false;

  return () => {
    if (released) return;
    released = true;
    scrollLockCount -= 1;

    if (scrollLockCount === 0) {
      restorePageScroll?.();
      restorePageScroll = undefined;
    }
  };
}
