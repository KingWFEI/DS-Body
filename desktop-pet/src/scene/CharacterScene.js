import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

/** 创建透明渲染场景，并集中管理相机、OrbitControls 和窗口尺寸。 */
export function createCharacterScene(viewport) {
  const scene = new THREE.Scene();
  // 显式请求高性能独显，并按屏幕原生像素比（1:1 物理像素）渲染，避免高分屏非整数缩放导致边缘发糊。
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.appendChild(renderer.domElement);

  let cameraViewHeight = 2;
  let home = {
    position: new THREE.Vector3(0, 1, 3),
    target: new THREE.Vector3(0, 1, 0),
  };
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  // 桌宠视角固定：禁用鼠标旋转、滚轮缩放和拖拽平移。
  controls.enableRotate = false;
  controls.enableZoom = false;
  controls.enablePan = false;
  controls.minDistance = 0.5;
  controls.maxDistance = 20;

  scene.add(new THREE.HemisphereLight(0xffffff, 0xbecae5, 2));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.3);
  keyLight.position.set(2, 5, 6);
  scene.add(keyLight);

  function resize() {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    const aspect = width / height;
    camera.left = (-cameraViewHeight * aspect) / 2;
    camera.right = (cameraViewHeight * aspect) / 2;
    camera.top = cameraViewHeight / 2;
    camera.bottom = -cameraViewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
    renderer.setSize(width, height);
  }

  function resetCamera() {
    camera.position.copy(home.position);
    camera.zoom = 1;
    controls.target.copy(home.target);
    camera.updateProjectionMatrix();
    controls.update();
    return getCameraState();
  }

  function fitCameraToModel(modelRoot) {
    const bounds = new THREE.Box3().setFromObject(modelRoot);
    if (bounds.isEmpty()) return null;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const aspect = Math.max(1, viewport.clientWidth) / Math.max(1, viewport.clientHeight);
    cameraViewHeight = Math.max(size.y * 1.48, (size.x / aspect) * 1.2, 1.2);
    resize();

    const distance = Math.max(size.y * 3.5, 3);
    home = {
      position: new THREE.Vector3(
        center.x,
        center.y + size.y * 0.03,
        center.z + distance,
      ),
      target: center,
    };
    resetCamera();
    // 只在模型加载时投影包围盒，拖动时不遍历骨骼和三角面。
    camera.updateMatrixWorld(true);
    const points = Array.from({ length: 8 }, (_, index) => new THREE.Vector3(
      index & 1 ? bounds.max.x : bounds.min.x,
      index & 2 ? bounds.max.y : bounds.min.y,
      index & 4 ? bounds.max.z : bounds.min.z,
    ).project(camera));
    const interactionRegion = {
      left: Math.max(0, (Math.min(...points.map((point) => point.x)) + 1) / 2 - 0.02),
      right: Math.min(1, (Math.max(...points.map((point) => point.x)) + 1) / 2 + 0.02),
      top: Math.max(0, (1 - Math.max(...points.map((point) => point.y))) / 2 - 0.02),
      bottom: Math.min(1, (1 - Math.min(...points.map((point) => point.y))) / 2 + 0.02),
    };
    return { center, size, characterHeight: size.y, interactionRegion };
  }

  function getCameraState() {
    const spherical = new THREE.Spherical().setFromVector3(
      camera.position.clone().sub(controls.target),
    );
    return {
      yaw: THREE.MathUtils.radToDeg(spherical.theta),
      pitch: 90 - THREE.MathUtils.radToDeg(spherical.phi),
      zoom: camera.zoom,
    };
  }

  function dispose() {
    window.removeEventListener("resize", resize);
    controls.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  }

  window.addEventListener("resize", resize);
  resize();

  return Object.freeze({
    scene,
    renderer,
    camera,
    controls,
    fitCameraToModel,
    resetCamera,
    getCameraState,
    dispose,
  });
}
