import { useLingui } from "@lingui/react";
import Lightbox from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";

type ZoomableLightboxProps = {
  src: string;
  alt: string;
  onClose: () => void;
};

export default function ZoomableLightbox({ src, alt, onClose }: ZoomableLightboxProps) {
  const { i18n } = useLingui();
  return (
    <Lightbox
      open
      labels={{
        Close: i18n._("Close"),
        "Zoom in": i18n._("Zoom in"),
        "Zoom out": i18n._("Zoom out"),
      }}
      close={onClose}
      slides={[{ src, alt }]}
      plugins={[Zoom]}
      carousel={{ finite: true }}
      controller={{ closeOnBackdropClick: true }}
      render={{ buttonPrev: () => null, buttonNext: () => null }}
    />
  );
}
