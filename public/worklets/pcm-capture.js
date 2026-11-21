/*
 * pcm-capture — the dictation audio path (STT wave, 2026-09-17).
 *
 * Runs OFF the main thread (AudioWorklet): converts the mic's Float32
 * samples to 16-bit little-endian PCM (linear16) and hands buffers to the
 * main thread in two streams:
 *
 *   { type: "level", rms }  — every render quantum (128 samples ≈ 8ms at
 *                             16kHz): the quantum's RMS level, 0..1. This
 *                             is the meter's heartbeat; posting per quantum
 *                             is what makes the meter feel instant (the
 *                             dominant latency in the owner's terminal
 *                             version was a 256ms IO buffer — see
 *                             ~/.pi/agent/extensions/dictate).
 *   { type: "audio", buffer } — Int16Array frames of 2048 samples (128ms),
 *                             zero-copy (transferred). Deepgram recommends
 *                             ~100–200ms chunks; silence is streamed too,
 *                             so the socket never idles (no KeepAlive
 *                             needed — the 10s NET-0001 timeout only bites
 *                             a stream that stops SENDING).
 *
 * Ships as a static file under public/ so it rides the standalone bundle.
 * Plain JS by necessity (worklets run outside the module graph).
 */
class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.frame = new Int16Array(2048);
		this.count = 0;
		// FORK (Firefox sample rate): Firefox can't run a 16 kHz context against a
		// 48/44.1 kHz mic, so the page may ask for a native-rate context plus
		// conversion here (processorOptions.targetRate). Without it, or when the
		// context already runs at the target rate, the loop below is untouched.
		const target = options && options.processorOptions && options.processorOptions.targetRate;
		this.mode = "direct";
		if (typeof target === "number" && target > 0 && target !== sampleRate) {
			this.mode = sampleRate > target ? "down" : "up";
			this.step = sampleRate / target; // input samples per output sample
			// down: fractional box average. acc = sum of input over the current
			// output window so far; filled = how much of the window (in input
			// samples) it already covers.
			this.acc = 0;
			this.filled = 0;
			// up: linear interpolation. prev = last input sample, pos = input
			// position of the next output relative to prev (0..1 of a step).
			this.prev = 0;
			this.hasPrev = false;
			this.pos = 0;
		}
	}

	push(value) {
		const s = Math.max(-1, Math.min(1, value));
		this.frame[this.count++] = s < 0 ? s * 0x8000 : s * 0x7fff;
		if (this.count === this.frame.length) {
			this.port.postMessage({ type: "audio", buffer: this.frame }, [this.frame.buffer]);
			this.frame = new Int16Array(2048);
			this.count = 0;
		}
	}

	process(inputs) {
		const channel = inputs[0] && inputs[0][0];
		if (!channel) return true; // no input yet — stay alive

		// RMS for the meter (float domain, before conversion).
		let sumSquares = 0;
		for (let i = 0; i < channel.length; i++) sumSquares += channel[i] * channel[i];
		this.port.postMessage({ type: "level", rms: Math.sqrt(sumSquares / channel.length) });

		if (this.mode === "down") {
			// Each output sample is the mean of the input over its exact time
			// window (step input samples wide); the boundary input sample is
			// split proportionally and the remainder carries into the next window.
			const step = this.step;
			for (let i = 0; i < channel.length; i++) {
				const x = channel[i];
				let weight = 1;
				while (this.filled + weight >= step) {
					const take = step - this.filled;
					this.push((this.acc + x * take) / step);
					weight -= take;
					this.acc = 0;
					this.filled = 0;
				}
				this.acc += x * weight;
				this.filled += weight;
			}
			return true;
		}

		if (this.mode === "up") {
			// Linear interpolation between neighbouring input samples; the
			// output at input position t (relative to prev) is prev + (x-prev)*t.
			const step = this.step; // < 1
			for (let i = 0; i < channel.length; i++) {
				const x = channel[i];
				if (!this.hasPrev) {
					this.hasPrev = true;
					this.prev = x;
					this.pos = 0;
				}
				// Emit every output that falls between prev and x.
				while (this.pos < 1) {
					this.push(this.prev + (x - this.prev) * this.pos);
					this.pos += step;
				}
				this.pos -= 1;
				this.prev = x;
			}
			return true;
		}

		// Float32 → Int16 (clamp first: a hot mic can exceed ±1.0).
		for (let i = 0; i < channel.length; i++) {
			const s = Math.max(-1, Math.min(1, channel[i]));
			this.frame[this.count++] = s < 0 ? s * 0x8000 : s * 0x7fff;
			if (this.count === this.frame.length) {
				this.port.postMessage({ type: "audio", buffer: this.frame }, [this.frame.buffer]);
				this.frame = new Int16Array(2048);
				this.count = 0;
			}
		}
		return true;
	}
}

registerProcessor("pcm-capture", PcmCaptureProcessor);
