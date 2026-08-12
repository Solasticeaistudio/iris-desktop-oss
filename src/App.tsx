import { getCurrentWindow } from '@tauri-apps/api/window';
import { IrisWindow } from './components/IrisWindow';
import { CanvasWindow } from './components/CanvasWindow';
import { AnnotationOverlay } from './components/AnnotationOverlay';
import { GridCalibrator } from './components/GridCalibrator';
import './index.css';

function MainApp() {
  const label = getCurrentWindow().label;

  if (label === 'grid-calibrator') return <GridCalibrator />;
  if (label === 'annotation') return <AnnotationOverlay />;
  if (label === 'canvas') return <CanvasWindow />;

  return <IrisWindow />;
}

export default function App() {
  return <MainApp />;
}
