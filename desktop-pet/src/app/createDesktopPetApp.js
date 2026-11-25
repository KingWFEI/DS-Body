import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
} from "@pixiv/three-vrm-animation";
import { createCharacterApi } from "../api/CharacterApi.js";
import { MotionController } from "../animation/MotionController.js";
import { DEFAULT_MOTION, MOTION_OPTIONS } from "../animation/motionCatalog.js";
import { CharacterOrientationController, getModelForwardYaw } from "../character/CharacterOrientationController.js";
import { LocomotionController } from "../character/LocomotionController.js";
import { ModelScaleController } from "../character/ModelScaleController.js";
import { WalkController } from "../character/WalkController.js";
import { createCharacterScene } from "../scene/CharacterScene.js";
import { createDebugPanel } from "../ui/DebugPanel.js";

/** 负责组装各模块并管理桌宠模型的加载、动画循环和生命周期。 */
export function createDesktopPetApp() {
  const debugPanel = createDebugPanel({ motionOptions: MOTION_OPTIONS });
  const characterScene = createCharacterScene(debugPanel.viewport);
  const locomotion = new LocomotionController();
  const modelScaleController = new ModelScaleController({
    onScaleChange: (scale) => globalThis.__desktopPetBridge?.setWindowScale?.(scale),
  });
  const loader = createModelLoader();
  const baseUrl = import.meta.env.BASE_URL;
  const motionController = new MotionController({
    loader,
    motionUrl: (name) => `${baseUrl}motions/${name}`,
    setStatus: debugPanel.setStatus,
  });

  let vrm = null;
  let mixer = null;
  let characterRoot = null;
  let characterVisualRoot = null;
  let orientationController = null;
  let walkController = null;
  let characterHeight = 1;
  let previousLocomotionMode = "idle";
  let animationFrame = null;
  let started = false;
  let disposed = false;
  const clock = new THREE.Clock();

  const { api: characterApi, publishMovementState } = createCharacterApi({
    locomotion,
    modelScaleController,
    motionController,
    cameraController: characterScene,
    getOrientationController: () => orientationController,
    isReady: () => Boolean(vrm && mixer),
  });
  window.character = characterApi;
  const unbindDebugPanel = debugPanel.bindCharacterApi(characterApi);

  async function loadCharacter() {
    try {
      debugPanel.setStatus("正在加载 public/models/BlueFatFish.vrm …");
      const data = await loader.loadAsync(`${baseUrl}models/BlueFatFish.vrm`);
      vrm = data.userData.vrm;
      if (!vrm) throw new Error("文件可读取，但没有解析到 VRM 数据");

      const modelForwardYaw = getModelForwardYaw(vrm.scene.quaternion);
      // 禁用子节点视锥裁剪，避免动画肢体超出原始模型边界时被错误隐藏。
      vrm.scene.traverse((object) => {
        object.frustumCulled = false;
      });
      if (vrm.lookAt) {
        const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt);
        lookAtProxy.name = "lookAtQuaternionProxy";
        vrm.scene.add(lookAtProxy);
      }

      characterRoot = new THREE.Group();
      characterRoot.name = "CharacterRoot";
      characterVisualRoot = new THREE.Group();
      characterVisualRoot.name = "CharacterVisualRoot";
      characterRoot.add(characterVisualRoot);
      characterVisualRoot.add(vrm.scene);
      characterScene.scene.add(characterRoot);

      mixer = new THREE.AnimationMixer(vrm.scene);
      walkController = new WalkController(vrm);
      motionController.attachModel(vrm, mixer);
      mixer.addEventListener("finished", handleMotionFinished);

      const fittedModel = characterScene.fitCameraToModel(characterRoot);
      characterHeight = fittedModel?.characterHeight ?? 1;
      debugPanel.setModelRegion(fittedModel?.interactionRegion);
      orientationController = new CharacterOrientationController(
        characterRoot,
        characterScene.camera,
        characterScene.controls.target,
        modelForwardYaw,
        { initialFacingOffsetRadians: THREE.MathUtils.degToRad(0) },
      );

      debugPanel.setStatus("模型加载成功。开始播放待机动画…");
      await characterApi.playMotion(DEFAULT_MOTION);
      publishMovementState(locomotion.getState());
    } catch (error) {
      debugPanel.setStatus(`模型加载失败：${error.message}。请检查 Network 和 Console。`);
      console.error(error);
    }
  }

  function handleMotionFinished(event) {
    if (!motionController.isCurrentAction(event.action)) return;
    if (motionController.getActiveMotion() === DEFAULT_MOTION) return;
    void characterApi.playMotion(DEFAULT_MOTION).catch((error) => console.error(error));
  }

  function handleLocomotionMode(state) {
    if (
      state.mode === "jumping" && previousLocomotionMode !== "jumping" &&
      (motionController.getActiveMotion() === DEFAULT_MOTION || !motionController.getActiveMotion())
    ) {
      void characterApi.playMotion("success/jump 1.vrma").catch((error) => console.error(error));
    }
    previousLocomotionMode = state.mode;
  }

  function updateFrame() {
    if (disposed) return;
    animationFrame = requestAnimationFrame(updateFrame);

    const deltaTime = Math.min(clock.getDelta(), 0.05);
    const state = locomotion.advance(deltaTime);
    handleLocomotionMode(state);

    if (orientationController) {
      state.yawDegrees = orientationController.update(state, deltaTime);
      locomotion.setYawDegrees(state.yawDegrees);
    }

    // 1. 先撤销上一帧程序化偏移，再按 VRMA 基础姿势叠加当前步态，并推进动作/临时表情自动恢复。
    walkController?.restore();
    mixer?.update(deltaTime);
    motionController.update(deltaTime);
    walkController?.update(deltaTime, state);

    // 2. 垂直移动通过视觉层起伏呈现，角色整体不倾斜。
    if (characterVisualRoot && walkController) {
      const floatingBob = state.mode === "floating"
        ? Math.sin(clock.elapsedTime * 2.4) * characterHeight * 0.012
        : 0;
      characterVisualRoot.position.y =
        state.airHeight * characterHeight * 0.12 + walkController.getBodyOffset() + floatingBob;
    }

    // 3. 最后更新 VRM 表情、骨骼和弹簧骨。
    vrm?.update(deltaTime);

    const currentState = locomotion.getState();
    publishMovementState(currentState);
    characterScene.renderer.render(characterScene.scene, characterScene.camera);
  }

  function start() {
    if (started || disposed) return;
    started = true;
    updateFrame();
    void loadCharacter();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (animationFrame !== null) cancelAnimationFrame(animationFrame);
    unbindDebugPanel();
    characterScene.dispose();
    if (window.character === characterApi) delete window.character;
  }

  return Object.freeze({ start, dispose, character: characterApi });
}

function createModelLoader() {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  return loader;
}
