import { AnchorHTMLAttributes, MouseEvent, useEffect, useState } from "react";

export function usePathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);
  useEffect(() => {
    const update = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("bookvault:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("bookvault:navigate", update);
    };
  }, []);
  return pathname;
}

export function Link({ href, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  function navigate(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    window.history.pushState(null, "", href);
    window.dispatchEvent(new Event("bookvault:navigate"));
  }
  return <a href={href} onClick={navigate} {...props} />;
}
