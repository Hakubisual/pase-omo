export const View = "View";
export const Text = "Text";
export const Pressable = "Pressable";
export const TextInput = "TextInput";
export const ScrollView = "ScrollView";
export const ActivityIndicator = "ActivityIndicator";
export const Platform = { OS: "web" as const, select: (o: Record<string, unknown>) => o.web ?? o.default };
export const StyleSheet = { create: <T>(s: T): T => s, flatten: <T>(s: T): T => s, absoluteFillObject: {} };
export const Dimensions = { get: () => ({ width: 1440, height: 900 }) };

/**
 * Enough of `Animated` for a component test to mount a node that animates.
 *
 * The real module drives values on the UI thread; the stub records them so a
 * test can assert what the component asked for without a timing dependency.
 */
class AnimatedValue {
  constructor(public value: number) {}
  setValue(next: number): void {
    this.value = next;
  }
}

type AnimationHandle = { start: (done?: () => void) => void; stop: () => void };

function animation(apply: () => void): AnimationHandle {
  return {
    start(done) {
      apply();
      done?.();
    },
    stop() {},
  };
}

export const Animated = {
  Value: AnimatedValue,
  View: "Animated.View",
  Text: "Animated.Text",
  timing(value: AnimatedValue, config: { toValue: number }): AnimationHandle {
    return animation(() => value.setValue(config.toValue));
  },
  parallel(animations: AnimationHandle[]): AnimationHandle {
    return animation(() => {
      for (const item of animations) item.start();
    });
  },
  sequence(animations: AnimationHandle[]): AnimationHandle {
    return animation(() => {
      for (const item of animations) item.start();
    });
  },
};
