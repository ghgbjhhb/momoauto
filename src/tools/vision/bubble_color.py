"""Color-only chat bubble segmentation shared by the chat-detail workers.

The model-2 detector deliberately does not assign a person to an avatar.  This
adapter uses the rendered bubble fill instead: MOMO's pale pink bubble is the
local user's message and the near-white bubble is the peer's message.
"""


def _odd(value):
    value = max(3, int(value))
    return value if value % 2 else value + 1


def _regions_from_mask(mask, color, sender, cv2, np, width, height):
    """Turn a color mask into conservative rounded-rectangle candidates."""
    kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (_odd(min(13, max(3, round(width * 0.015)))),
         _odd(min(11, max(3, round(height * 0.010)))))
    )
    raw_mask = mask.copy()
    mask = (mask.astype(np.uint8) * 255)
    # Remove thin compression bridges before closing text holes. Otherwise a
    # white avatar highlight can attach to a genuine bubble and distort its rim.
    opening = _odd(min(7, max(3, round(width * .007))))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (opening, opening)))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)

    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    min_width = max(24, round(width * 0.045))
    min_height = max(14, round(height * 0.018))
    regions = []
    for index in range(1, count):
        x, y, box_width, box_height, area = [int(v) for v in stats[index]]
        if box_width < min_width or box_height < min_height:
            continue
        if box_width > width * 0.94 or box_height > height * 0.85:
            continue
        density = area / max(1, box_width * box_height)
        if density < 0.20:
            continue
        # A chat bubble is wider than a random icon/avatar in the color mask.
        # Very short messages are allowed a lower ratio, but circular blobs are
        # still rejected so colorful avatars cannot become bubble evidence.
        if box_width / max(1, box_height) < 0.75:
            # Tall multiline bubbles are legitimate; narrow color streaks are not.
            if box_width < width * .30:
                continue
        # Closing connects white letters and sticker outlines too. Verify the
        # ORIGINAL fill along an inset rectangular border, before accepting it
        # as a bubble. Text holes inside a real bubble do not affect this rim.
        patch = raw_mask[y:y + box_height, x:x + box_width]
        inset_x = max(2, min(round(box_width * .12), round(width * .018)))
        inset_y = max(2, min(round(box_height * .12), round(height * .010)))
        band = max(1, round(width / 360))
        rim = np.concatenate((
            patch[inset_y:inset_y + band, inset_x:-inset_x].ravel(),
            patch[-inset_y - band:-inset_y, inset_x:-inset_x].ravel(),
            patch[inset_y:-inset_y, inset_x:inset_x + band].ravel(),
            patch[inset_y:-inset_y, -inset_x - band:-inset_x].ravel(),
        ))
        rim_fill = float(rim.mean()) if rim.size else 0.0
        raw_fill = float(patch.mean())
        if raw_fill < .55 or rim_fill < .90:
            continue
        confidence = min(0.99, max(0.50, 0.55 + density * 0.35))
        regions.append({
            "id": f"{color}-{len(regions)}",
            "color": color,
            "sender": sender,
            "confidence": round(float(confidence), 4),
            "shapeVerified": True,
            "fillRatio": round(raw_fill, 4),
            "rimFill": round(rim_fill, 4),
            "box": [x, y, x + box_width, y + box_height],
            "center": [x + box_width // 2, y + box_height // 2],
        })
    return regions


def detect_bubble_regions(image, cv2, np):
    """Return bubble boxes whose sender is determined by fill color only.

    The function intentionally does not inspect avatar detections or infer a
    sender from the horizontal position.  If a fill cannot be segmented, the
    JavaScript parser will leave that message as ``unknown``.
    """
    height, width = image.shape[:2]
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, saturation, value = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]

    top = int(height * 0.11)
    bottom = int(height * 0.90)
    roi = np.zeros((height, width), dtype=bool)
    roi[top:bottom, :] = True

    # MOMO's own bubble is pale pink/magenta.  The hue range is deliberately
    # broad enough for display scaling and compression, while saturation keeps
    # white/grey page background out of this mask.
    pink = roi & (saturation >= 10) & (value >= 145) & (
        ((hue >= 145) & (hue <= 179)) | (hue <= 8)
    )

    # The peer bubble is near-white, while the chat canvas is a slightly darker
    # cool grey.  Estimate that canvas value dynamically so 720p and 324px
    # screenshots use the same rule.
    background_pixels = value[roi & (saturation <= 10)]
    background_value = float(np.percentile(background_pixels, 50)) if background_pixels.size else 247.0
    white_threshold = int(min(255, max(248, background_value + 3)))
    white = roi & (saturation <= 10) & (value >= white_threshold)

    # MOMO SVIP / 会员浅黄色与金黄色气泡 (peer)
    # Hue: 12 ~ 35 (金黄/暖黄), Saturation >= 15, Value >= 165
    yellow = roi & (saturation >= 15) & (value >= 165) & (hue >= 12) & (hue <= 35)

    regions = _regions_from_mask(pink, "pink", "self", cv2, np, width, height)
    regions.extend(_regions_from_mask(white, "white", "peer", cv2, np, width, height))
    regions.extend(_regions_from_mask(yellow, "yellow", "peer", cv2, np, width, height))
    regions.sort(key=lambda region: (region["box"][1], region["box"][0], region["color"]))
    for index, region in enumerate(regions):
        region["id"] = f"bubble-{index}"
    return regions
