import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

type ZoomableLightboxProps = {
  src: string;
  alt: string;
  onClose: () => void;
};

export default function ZoomableLightbox({ src, alt, onClose }: ZoomableLightboxProps) {
  return (
    <Lightbox
      open
      close={onClose}
      slides={[{ src, alt }]}
      plugins={[Zoom]}
      carousel={{ finite: true }}
      controller={{ closeOnBackdropClick: true }}
      render={{ buttonPrev: () => null, buttonNext: () => null }}
    />
  );
}
