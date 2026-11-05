# GPU Undervolt for Omarchy

A bar widget for [Omarchy](https://omarchy.org) that shows live GPU metrics, switches
between **Stock** and **Efficiency**, and can tune an undervolt for your specific
card.

![The GPU Undervolt panel with the Efficiency profile active](preview.png)

> **Use at your own risk.** Tuning runs your GPU above its stock clock for a given
> voltage, and finding the limit can crash a game or end your desktop session. This
> has been tested on one graphics card so far: see [Tested hardware](#tested-hardware).

## Install

```bash
omarchy plugin add https://github.com/PSthelyBlog/omarchy-gpu-undervolt.git --enable
```

If LACT is missing, the panel offers a **Set up** button. Nothing changes on your
GPU until you choose Efficiency: a new install stays on Stock.

To update:

```bash
omarchy plugin update io.github.psthelyblog.gpu-undervolt
```

## Remove

```bash
omarchy plugin remove io.github.psthelyblog.gpu-undervolt
```

The GPU returns to Stock as soon as the plugin unloads. Your settings and the LACT
packages stay behind, so a reinstall keeps your tuning result. To remove those too:

```bash
rm -rf ~/.local/state/gpu-undervolt     # profile choice, tuning result and tune slots
rm -rf ~/.cache/gpu-undervolt           # the CUDA stress load, if it was ever built
```

LACT keeps an unused profile named `gpu-undervolt-efficiency`, which you can delete
in its GUI. If nothing else needs LACT or Deno, remove them with:

```bash
sudo systemctl disable --now lactd
sudo pacman -Rns lact deno
```

## Use

- Left click opens the panel, right click toggles the profile.
- **Tune for this GPU** in the panel finds your card's undervolt. It takes up to
  about 13 minutes at full GPU load. Save your work first.
- **Tune slots** in the panel keep up to four tunes. Right-click a slot to save the
  current tune in it, click a slot to apply its tune and switch Efficiency on. A
  slot saved on another GPU, driver or vBIOS is shown dimmed and is not applied.
- From a keybinding or script: `omarchy-shell gpu-undervolt.profile toggle`, or
  `set stock`, `set efficiency`, `get`, `tune`, `stopTune`, `saveSlot 1` to `4`,
  `applySlot 1` to `4`.

## Dependencies and privileges

| Dependency | Package | Used for |
|---|---|---|
| [LACT](https://github.com/ilya-zlobintsev/LACT) daemon | `lact` (Arch `extra`) | Reading the GPU and applying every setting. Required. |
| [Deno](https://deno.com) | `deno` (Arch `extra`) | Running the stress load. Only needed for tuning. |
| [CUDA toolkit](https://developer.nvidia.com/cuda-toolkit) | `cuda` (Arch `extra`) | Tuning an NVIDIA GPU that WebGPU cannot start on. Optional. |

The stress load runs on WebGPU. Only if WebGPU cannot start on your GPU does it
build `stress.cu`, the same load in CUDA, with `nvcc`, once, into
`~/.cache/gpu-undervolt`. CUDA 13, the version in Arch, no longer builds for GTX
10-series and older cards, so those need CUDA 12.9.

The plugin itself runs as your user. Two things run as root:

- **The Set up button**, once, after a polkit password prompt. It installs both
  packages and starts the daemon:

  ```bash
  pkexec /usr/bin/bash -c "pacman -S --needed --noconfirm -- lact deno && systemctl enable --now lactd"
  ```

  To do this yourself instead:

  ```bash
  sudo pacman -S --needed lact deno
  sudo systemctl enable --now lactd
  ```

- **`lactd`**, LACT's system service, which writes the GPU settings. Members of
  `wheel` can use its socket at `/run/lactd.sock` without a password.

Choosing Efficiency saves one profile, `gpu-undervolt-efficiency`, in LACT's config.
The plugin changes no other LACT profile. The stress load, `stress.ts`, has no
imports and no network access. Deno lets it read `stress.cu` and its cache, write
its cache, and run `nvcc` and `setpriv`, which it needs only for the CUDA build.

## Tested hardware

| GPU | Monitoring | Clock cap | Tuner |
|---|---|---|---|
| NVIDIA RTX 4070, driver 615.78.08 | Yes | Yes | Yes |
| AMD, Intel, hybrid laptops | Untested | Untested | Untested |

That RTX 4070 passed every step up to the tuner's +240 MHz ceiling in both full runs,
at 1000 mV and at 975 mV, so its real limit is unknown and no tuner step has ever
failed on real hardware. The error paths were tested with injected faults, not a
real GPU hang.

## How it works

The plugin talks to LACT's daemon over `/run/lactd.sock`. `omarchy plugin add` cannot
install root components, and LACT already provides the daemon, multi-vendor support
and reapply-on-resume.

Efficiency has three levels, and uses the best one available:

| Level | What it does | Risk |
|---|---|---|
| Tuned | The same rule on your card's tuned curve, which reaches each clock at a lower voltage | Tested on your card by the tuner |
| Clock cap | Stops climbing the stock VF curve where it stops being worth the power | None, this is the stock curve |
| Power cap | 75% of the default limit, for GPUs with no VF curve | None, but only acts above the cap |

The clock cap needs no hardcoded voltage. It stops where 1% more clock would cost
more than 3.5% more core power (P ~ f·V²), which the curve itself shows.

A tuned result only applies to the driver and vBIOS it was measured on. After an
update, Efficiency falls back to the clock cap until you re-tune.

### The tuner

1. Measures stock, to report the real cost of the result.
2. Raises the curve offset 30 MHz at a time. Each step runs at the knee of the
   tuned curve: the clock cap's rule, applied to the stock curve plus the offset.
   As the margin grows, the knee moves to a lower voltage and a higher clock, so
   the margin buys less power and more speed together, and each step tests the
   exact clock and voltage it would keep. Each step runs 45 seconds of
   `stress.ts`, a headless compute load that reaches the 200 W limit and
   alternates sustained load with bursts. On an NVIDIA GPU that WebGPU cannot
   start on, it runs the same load built with CUDA instead.
3. Stops at the first GPU error, failed load, or step where the work done per MHz
   falls more than 1% below the best step: the clock still reads as set, but the
   silicon is stretching it. It also stops at +240 MHz.
4. Backs off 30 MHz and runs a 5 minute soak, dropping further if that fails.

### Crash safety

Stock is the only state saved to disk. Efficiency is applied with LACT's
`hold_profile`, which lasts only while the plugin's connection stays open:

| Event | Result |
|---|---|
| Shell or compositor crashes | Connection drops, GPU returns to Stock, the stress load dies too |
| Hard freeze, then reboot | Boots on Stock; the hold was never saved |
| Plugin disabled | Connection closes, GPU returns to Stock |
| LACT restarts | Plugin re-applies Efficiency once it reconnects |
| Crash during a tuner step | That step counts as failed; the last good step minus 30 MHz is kept and flagged as not soak-tested |
| GPU error (Xid) while tuned | Undervolt drops 15 MHz and you get a notification |
| Session ended badly while tuned, or a GPU error the plugin did not see | Same, before anything is applied at the next login |

Any Xid counts, including ones caused by a buggy app. That can cost a little
efficiency, but it never makes the undervolt more aggressive. Each error counts
once: the login check skips errors the plugin already stepped down for. A game
crash that logs no Xid is not noticed.

Your choice is kept in `~/.local/state/gpu-undervolt/`. **Do not edit LACT profiles
during a hold**: any LACT config save writes the held profile to disk, which removes
the protection on the next boot. The plugin only edits its profile while no hold
exists. LACT also rejects `set_profile` during a hold, so changes from LACT's GUI
may fail while Efficiency is active.

To recover manually, add `lact-reset` to the kernel command line for one boot.

## Results

RTX 4070, driver 615.78.08, LACT 0.10.1, 2026-11-04, on `stress.ts`, which draws
about 200 W at stock. A full tuner run, with 45 second steps, a 5 minute soak and no
GPU errors:

| Step | Score | Watts | MHz | mV |
|---|---|---|---|---|
| Stock | 601,859 | 196.6 | 2737 | 1085 |
| +0 MHz (the clock cap) | 572,331 | 154.0 | 2610 | 1000 |
| +30 MHz | 567,545 | 144.6 | 2580 | 975 |
| +90 MHz | 579,480 | 146.3 | 2640 | 975 |
| +150 MHz | 593,203 | 149.0 | 2700 | 975 |
| +210 MHz | 605,248 | 148.3 | 2757 | 975 |
| +240 MHz (tuner ceiling) | 612,101 | 149.6 | 2764 | 975 |
| **Saved: +210 MHz, 5 min soak** | 608,288 | 148.1 | 2735 | 975 |

The saved result, a 2760 MHz cap at the 970 mV curve point, runs at stock speed for
a quarter less power: +1% speed for -25% power. It idles normally too, at 13 W in P8.
The voltage sensor reads 975 mV at that point.

Any offset moves the knee from 1000 mV down to 975 mV, where it stays, so from +30
MHz on each step adds clock at the same voltage for about 1 W. In the soak the clock
averaged below its 2760 MHz cap because the card sheds clock as it warms. Work per
MHz varied by 1% across the climb and was highest at the top steps, so no clock was
being stretched.

The first tuner, in the initial release, held the stock curve's knee voltage and
spent the whole margin on clock. Its full run on 2026-11-02 saved +210 MHz at 1000
mV, a 2820 MHz cap: +4% speed for -16% power, at 162.3 W against 192.9 W at stock
that day. The knee result does 7% more work per watt than that one, or 8% when each
is compared with its own day's stock run.

Earlier runs used `vkmark`, whose heaviest GPU-bound scene peaks near 140 W. There,
a 150 W power cap saved nothing, which is why Efficiency is now a clock cap. These
are short runs: they measure efficiency, not long-term stability, and a compute
load is not a game.

One real game session so far, on the first tuner's +210 MHz profile: S.T.A.L.K.E.R.
2 on Proton Experimental at Epic settings, 1080p, no frame generation, about an hour
under load. The GPU sat at the 2820 MHz cap and 1000 mV for 97% of loaded samples,
at a median of 132 W, a peak of 166 W and a peak core temperature of 71 °C. There
were no GPU errors, no step-downs and no visual glitches noticed while playing. The
game segfaulted in Proton's `ntdll.so` while exiting, after it had closed its own
log. Nothing links that to the GPU, but there is no stock session to compare it with,
and no stock power figure for this game. No game has been played on the knee tuner's
result yet.

## Development

```bash
node --test tests/                               # Model.js logic, real RTX 4070 curve
python3 -m unittest discover -s tests -p 'test_*.py'  # spike curve builder, CUDA fallback
python3 tests/integration.py                     # Service.qml end to end, headless, ~3 min
```

`tests/integration.py` never writes to the GPU. It pins `GPU_UNDERVOLT_SOCKET` to a
mock daemon so it cannot reach a real one, and replaces `deno`, `journalctl` and the
notifier with scripts, so GPU errors, hangs and crashes can be injected. The mock
also fails any profile edit made during a hold.

To see the UI on a machine without LACT, run `python3 tools/mock-lactd.py`: the
plugin also looks for a socket at `$XDG_RUNTIME_DIR/lactd.sock`.

To try local changes, copy the plugin files in and restart the shell. Hot reload
is not enough: `Service.qml` uses `keepLoaded`, and `Panel.qml` edits stayed stale
even when the shell logged a reload.

```bash
cp manifest.json Service.qml LactClient.qml Panel.qml Model.js SharedService.js \
  stress.ts stress.cu ~/.config/omarchy/plugins/io.github.psthelyblog.gpu-undervolt/
omarchy restart shell
```

These change real GPU settings, and a GPU fault can end your session:

```bash
python3 tools/bounded-tune.py --max-offset 60   # real tuner, limited climb, temporary state
python3 tools/spike.py status                   # read-only
python3 tools/spike.py hold                     # power cap only
python3 tools/spike.py curve                    # writes +30 MHz at idle, checks the reset
python3 tools/spike.py measure                  # needs vkmark
```

To run the CUDA load on a GPU where WebGPU works, hide WebGPU from it. This builds
it into the real cache, as a tuner run would:

```bash
DENO_WEBGPU_BACKEND=dx12 deno run --unstable-webgpu --no-prompt \
  --allow-read=stress.cu,$HOME/.cache/gpu-undervolt --allow-write=$HOME/.cache/gpu-undervolt \
  --allow-run=setpriv,nvcc,/opt/cuda/bin/nvcc stress.ts 30 ~/.cache/gpu-undervolt
```

## License

[MIT](LICENSE)
