import { useState } from "react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

type ZoomableImageProps = {
  src: string;
  alt: string;
  caption?: string;
};

export function ZoomableImage({ src, alt, caption }: ZoomableImageProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <figure className="w-28 overflow-hidden rounded-md border bg-background">
        <button
          type="button"
          className="block w-full cursor-zoom-in"
          onClick={() => setOpen(true)}
          aria-label={`Zoom ${caption ?? alt}`}
        >
          <img className="aspect-square w-full object-cover" src={src} alt={alt} />
        </button>
        {caption ? <figcaption className="truncate px-2 py-1 text-xs text-muted-foreground">{caption}</figcaption> : null}
      </figure>
      <Lightbox
        open={open}
        close={() => setOpen(false)}
        slides={[{ src, alt }]}
        plugins={[Zoom]}
        carousel={{ finite: true }}
        controller={{ closeOnBackdropClick: true }}
        render={{ buttonPrev: () => null, buttonNext: () => null }}
      />
    </>
  );
}
