import type { NgtSignalStore } from './stores/signal.store';
import type { NgtState } from './types';

export type NgtGlobalRenderCallback = (timestamp: number) => void;
type NgtSubItem = { callback: NgtGlobalRenderCallback };

function createSubs(callback: NgtGlobalRenderCallback, subs: Set<NgtSubItem>): () => void {
    const sub = { callback };
    subs.add(sub);
    return () => void subs.delete(sub);
}

const globalEffects: Set<NgtSubItem> = new Set();
const globalAfterEffects: Set<NgtSubItem> = new Set();
const globalTailEffects: Set<NgtSubItem> = new Set();

/**
 * Adds a global render callback which is called each frame.
 * @see https://docs.pmnd.rs/react-three-fiber/api/additional-exports#addEffect
 */
export const addEffect = (callback: NgtGlobalRenderCallback) => createSubs(callback, globalEffects);

/**
 * Adds a global after-render callback which is called each frame.
 * @see https://docs.pmnd.rs/react-three-fiber/api/additional-exports#addAfterEffect
 */
export const addAfterEffect = (callback: NgtGlobalRenderCallback) => createSubs(callback, globalAfterEffects);

/**
 * Adds a global callback which is called when rendering stops.
 * @see https://docs.pmnd.rs/react-three-fiber/api/additional-exports#addTail
 */
export const addTail = (callback: NgtGlobalRenderCallback) => createSubs(callback, globalTailEffects);

function run(effects: Set<NgtSubItem>, timestamp: number) {
    if (!effects.size) return;
    for (const { callback } of effects.values()) {
        callback(timestamp);
    }
}

export type GlobalEffectType = 'before' | 'after' | 'tail';

export function flushGlobalEffects(type: GlobalEffectType, timestamp: number): void {
    switch (type) {
        case 'before':
            return run(globalEffects, timestamp);
        case 'after':
            return run(globalAfterEffects, timestamp);
        case 'tail':
            return run(globalTailEffects, timestamp);
    }
}

function render(timestamp: number, store: NgtSignalStore<NgtState>, frame?: XRFrame) {
    const state = store.get();
    // Run local effects
    let delta = state.clock.getDelta();
    // In frameloop='never' mode, clock times are updated using the provided timestamp
    if (state.frameloop === 'never' && typeof timestamp === 'number') {
        delta = timestamp - state.clock.elapsedTime;
        state.clock.oldTime = state.clock.elapsedTime;
        state.clock.elapsedTime = timestamp;
    }
    // Call subscribers (useFrame)
    const subscribers = state.internal.subscribers;
    for (let i = 0; i < subscribers.length; i++) {
        const subscription = subscribers[i];
        subscription.callback({ ...subscription.store.get(), delta, frame });
    }
    // Render content
    if (!state.internal.priority && state.gl.render) state.gl.render(state.scene, state.camera);
    // Decrease frame count
    state.internal.frames = Math.max(0, state.internal.frames - 1);
    return state.frameloop === 'always' ? 1 : state.internal.frames;
}

export function createLoop<TCanvas>(roots: Map<TCanvas, NgtSignalStore<NgtState>>) {
    let running = false;
    let repeat: number;
    let frame: number;

    function loop(timestamp: number): void {
        frame = requestAnimationFrame(loop);
        running = true;
        repeat = 0;

        // Run effects
        flushGlobalEffects('before', timestamp);

        // Render all roots
        for (const root of roots.values()) {
            const state = root.get();
            // If the frameloop is invalidated, do not run another frame
            if (
                state.internal.active &&
                (state.frameloop === 'always' || state.internal.frames > 0) &&
                !state.gl.xr?.isPresenting
            ) {
                repeat += render(timestamp, root);
            }
        }

        // Run after-effects
        flushGlobalEffects('after', timestamp);

        // Stop the loop if nothing invalidates it
        if (repeat === 0) {
            // Tail call effects, they are called when rendering stops
            flushGlobalEffects('tail', timestamp);

            // Flag end of operation
            running = false;
            return cancelAnimationFrame(frame);
        }
    }

    function invalidate(store?: NgtSignalStore<NgtState>, frames = 1): void {
        const state = store?.get();
        if (!state) return roots.forEach((root) => invalidate(root, frames));
        if (state.gl.xr?.isPresenting || !state.internal.active || state.frameloop === 'never') return;
        // Increase frames, do not go higher than 60
        state.internal.frames = Math.min(60, state.internal.frames + frames);
        // If the render-loop isn't active, start it
        if (!running) {
            running = true;
            requestAnimationFrame(loop);
        }
    }

    function advance(
        timestamp: number,
        runGlobalEffects: boolean = true,
        store?: NgtSignalStore<NgtState>,
        frame?: XRFrame
    ): void {
        const state = store?.get();
        if (runGlobalEffects) flushGlobalEffects('before', timestamp);
        if (!state) for (const root of roots.values()) render(timestamp, root);
        else render(timestamp, store!, frame);
        if (runGlobalEffects) flushGlobalEffects('after', timestamp);
    }

    return {
        loop,
        /**
         * Invalidates the view, requesting a frame to be rendered. Will globally invalidate unless passed a root's state.
         * @see https://docs.pmnd.rs/react-three-fiber/api/additional-exports#invalidate
         */
        invalidate,
        /**
         * Advances the frameloop and runs render effects, useful for when manually rendering via `frameloop="never"`.
         * @see https://docs.pmnd.rs/react-three-fiber/api/additional-exports#advance
         */
        advance,
    };
}
