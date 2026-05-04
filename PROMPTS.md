# Prompts

## Keyframe Image Sequence

Generate a reusable green-screen keyframe sequence for a cat screensaver animation.

Inputs:

- Cat identity reference: use the new cat photos and/or the written cat description as the only source of identity. Preserve the same cat across every frame.
- Action reference sequence: use `./assets/raw-furryball/001.png` through `./assets/raw-furryball/012.png` in order. These images are pose and motion references only. Do not copy Furryball's face, fur pattern, color, body shape, or breed traits.
- Output directory: `./assets/raw-<cat-name>/`

Core instruction:

Create the new cat with a stable identity while matching the body pose, camera angle, movement stage, and composition of each corresponding `raw-furryball` reference frame.

Frame plan:

- `001.png`: entering the frame from the right.
- `002.png`: side-view walking pose.
- `003.png`: side-view walk, slightly closer to camera.
- `004.png`: three-quarter walking pose.
- `005.png`: front-facing walk.
- `006.png`: head lowered, preparing to stop.
- `007.png`: crouching with one front paw reaching forward.
- `008.png`: deep crouch, body close to the ground.
- `009.png`: low lying transition.
- `010.png`: relaxed lying pose.
- `011.png`: lying down with a small head turn or head lift.
- `012.png`: relaxed seated/lying final pose.

Image requirements:

- The cat must be the same individual in every frame: same coat color, markings, face shape, eye color, body proportions, fur length, tail type, paw color, and overall personality.
- Use the action reference only for pose, angle, silhouette, body placement, and animation continuity.
- Photorealistic cat, natural fur texture, clean silhouette, crisp edges, full body visible whenever the reference frame shows the full body.
- Match the existing sequence size and framing as closely as possible.
- Background must be a perfectly flat solid `#00ff00` green screen.
- No shadows, gradients, floor plane, texture, reflections, furniture, props, text, watermark, UI, border, or second animal.
- Do not use green anywhere on the cat.
- Leave enough padding around ears, paws, and tail for chroma-key extraction.
- Save outputs as `001.png` through `012.png` in the output directory.

Identity lock:

The new cat identity is more important than the action reference. If identity and pose conflict, preserve the new cat's identity and approximate the pose.

Single-frame prompt template:

```text
Generate keyframe <index> for a green-screen cat screensaver sequence.

Cat identity reference:
<insert the new cat photos and/or a precise written description here>

Action reference:
Use `./assets/raw-furryball/<index>.png` only for the pose, camera angle, silhouette, body placement, and animation stage. Do not copy the reference cat's appearance.

Create the same new cat from the identity reference in this exact action pose. Preserve the cat's coat color, markings, face shape, eye color, body proportions, fur length, paw color, tail type, and overall identity consistently.

Style: photorealistic, natural fur texture, clean edges, full-body composition when applicable.
Background: perfectly flat solid `#00ff00` green screen, with no shadow, floor, gradient, texture, reflection, props, text, watermark, UI, border, or other animal.
Avoid: green on the cat, changed breed, changed coat pattern, changed body size, cropped ears, cropped paws, cropped tail, extra limbs, deformed anatomy.

Output: `./assets/raw-<cat-name>/<index>.png`
```

Batch prompt template:

```text
Generate a 12-frame green-screen keyframe sequence for a cat screensaver.

Use my new cat photos and/or description as the identity reference. The cat must remain the same individual across all 12 frames.

Use `./assets/raw-furryball/001.png` through `./assets/raw-furryball/012.png` as ordered action references only. Match each frame's pose, camera angle, silhouette, body placement, and animation stage, but do not inherit Furryball's appearance.

For every frame:
- Preserve the new cat's stable identity: coat color, markings, face shape, eye color, body proportions, fur length, paw color, tail type, and personality.
- Use photorealistic natural cat fur with crisp chroma-key-friendly edges.
- Use a perfectly flat solid `#00ff00` green-screen background.
- No shadows, gradients, floor plane, texture, reflections, props, text, watermark, UI, border, or second animal.
- Do not place any green color on the cat.
- Keep the subject complete with enough padding around ears, paws, and tail.

Save the frames as `001.png` through `012.png` in `./assets/raw-<cat-name>/`.
```

## Video Generation

Generate a 10-second continuous green-screen cat video using the ordered green-screen cat keyframes as strict visual references.

Input:

- Use the uploaded/generated green-screen cat images in sequence order as the only visual reference for the cat.
- The cat must remain the same individual throughout the full video.
- Preserve the same coat color, markings, face shape, eye color, body proportions, fur length, paw color, tail type, pose style, fur edge detail, and overall identity.
- Do not redesign the cat, change its breed, alter its color, change its body size, change its face shape, or change its fur length.

Timeline:

0-3 seconds:

Use the first walking keyframes as reference. The cat slowly enters from the right side of the frame in a natural side-walking pose. The full body should be visible. The cat moves from the right side toward the lower center of the frame. Keep scale and perspective stable.

3-5 seconds:

Use the next transition keyframes as reference. The cat gradually stops, turns slightly toward the camera, and lowers its head as if preparing to block the screen. The motion should be slow, weighted, and continuous, with no abrupt pose jump.

5-6.5 seconds:

Use the crouching and lowering keyframes as reference. The cat bends its front legs and smoothly lowers from standing into a lying or sprawled pose. The body expands horizontally and begins occupying the lower half of the frame. Keep the cat's identity exactly consistent.

6.5-10 seconds:

Use the final lying/seated keyframes as the ending pose. The cat stays mostly still, as if calmly and firmly blocking the screen. Only subtle breathing motion is allowed in the chest and belly. Do not add obvious head movement, eye movement, paw movement, blinking, standing, walking, or a new pose. End on a stable final pose.

Visual requirements:

- 16:9 video.
- Fixed composition and fixed green-screen background.
- The cat must remain complete in frame; do not crop ears, paws, tail, or whiskers.
- The cat edges must stay clean and suitable for chroma-keying.
- Background must remain perfectly flat solid `#00ff00` for the entire video.
- No web page, browser UI, countdown, text, room, floor, furniture, shadow, props, second cat, or other object.

Camera requirements:

- The camera must be completely locked.
- No camera movement, pan, tilt, zoom, dolly, rotation, tracking, reframing, or perspective shift.
- The cat may move through its own body motion only.
- Do not make the cat appear larger or smaller because of camera movement.
- The green background must remain static and uniform.
