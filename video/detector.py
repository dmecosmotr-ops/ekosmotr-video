"""Local CPU-only official YOLOX Nano ONNX inference, imported lazily.

Preprocessing and raw YOLOX grid/stride decode adapted from YOLOX:
https://github.com/Megvii-BaseDetection/YOLOX/tree/6ddff4824372906469a7fae2dc3206c7aa4bbaee
yolox/data/data_augment.py (preproc), yolox/utils/demo_utils.py
(demo_postprocess), demo/ONNXRuntime/onnx_inference.py (box conversion).
Copyright (c) Megvii, Inc. and its affiliates. Licensed under Apache-2.0.
See the accompanying third-party notice and Apache-2.0 license.
Changes: fixed official Nano input, normalized output,
strict pinned artifact verification and bounded CPU execution settings.
"""
from math import isfinite

from .fetch_model import verify_model
from .tracking import Detection

COCO_TARGETS = {0: 'person', 2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}


class YoloXDetector:
    def __init__(self, model_path, score_threshold=.35, nms_threshold=.45, threads=2):
        if not isfinite(score_threshold) or not .05 <= score_threshold <= .95:
            raise ValueError('invalid score threshold')
        if not isfinite(nms_threshold) or not .1 <= nms_threshold <= .9:
            raise ValueError('invalid NMS threshold')
        if not isinstance(threads, int) or not 1 <= threads <= 4:
            raise ValueError('CPU threads must be 1..4')
        model = verify_model(model_path)
        import numpy as np
        import onnxruntime as ort
        self.np = np
        self.threshold = score_threshold
        self.nms_threshold = nms_threshold
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
        inputs = self.session.get_inputs()
        if len(inputs) != 1 or inputs[0].shape != [1, 3, 416, 416] or inputs[0].type != 'tensor(float)':
            raise ValueError('unexpected official Nano input tensor')
        self.input_name = inputs[0].name
        grids, strides = [], []
        for stride in (8, 16, 32):
            y, x = np.mgrid[:416 // stride, :416 // stride]
            grid = np.stack((x, y), axis=-1).reshape(-1, 2)
            grids.append(grid)
            strides.append(np.full((len(grid), 1), stride))
        self.grids, self.strides = np.concatenate(grids), np.concatenate(strides)

    def _nms(self, boxes, scores):
        np = self.np
        order = scores.argsort()[::-1][:300]
        keep = []
        while order.size:
            i = int(order[0])
            keep.append(i)
            remaining = order[1:]
            if not remaining.size:
                break
            left_top = np.maximum(boxes[i, :2], boxes[remaining, :2])
            right_bottom = np.minimum(boxes[i, 2:], boxes[remaining, 2:])
            intersection = np.maximum(0, right_bottom - left_top).prod(axis=1)
            areas = np.maximum(0, boxes[remaining, 2:] - boxes[remaining, :2]).prod(axis=1)
            area_i = np.maximum(0, boxes[i, 2:] - boxes[i, :2]).prod()
            iou = intersection / np.maximum(area_i + areas - intersection, 1e-10)
            order = remaining[iou <= self.nms_threshold]
        return keep

    def detect(self, frame):
        import cv2
        np = self.np
        if frame is None or frame.ndim != 3 or frame.shape[2] != 3 or frame.dtype != np.uint8:
            raise ValueError('uint8 BGR frame required')
        height, width = frame.shape[:2]
        if not 1 <= height <= 2160 or not 1 <= width <= 3840:
            raise ValueError('frame exceeds bounded resolution')
        ratio = min(416 / height, 416 / width)
        resized = cv2.resize(frame, (max(1, int(width * ratio)), max(1, int(height * ratio))), interpolation=cv2.INTER_LINEAR)
        padded = np.full((416, 416, 3), 114, dtype=np.uint8)
        padded[:resized.shape[0], :resized.shape[1]] = resized
        tensor = np.ascontiguousarray(padded.transpose(2, 0, 1), dtype=np.float32)[None]
        raw = self.session.run(None, {self.input_name: tensor})[0]
        if raw.shape != (1, len(self.grids), 85) or not np.isfinite(raw).all():
            raise ValueError('invalid detector output tensor')
        prediction = raw[0].copy()
        prediction[:, :2] = (prediction[:, :2] + self.grids) * self.strides
        prediction[:, 2:4] = np.exp(np.clip(prediction[:, 2:4], -20, 20)) * self.strides
        boxes = np.column_stack((prediction[:, :2] - prediction[:, 2:4] / 2,
                                 prediction[:, :2] + prediction[:, 2:4] / 2)) / ratio
        boxes[:, [0, 2]] = np.clip(boxes[:, [0, 2]] / width, 0, 1)
        boxes[:, [1, 3]] = np.clip(boxes[:, [1, 3]] / height, 0, 1)
        best_classes = prediction[:, 5:].argmax(axis=1)
        best_scores = prediction[:, 4] * prediction[np.arange(len(prediction)), 5 + best_classes]
        return self.select_detections(boxes, best_scores, best_classes)

    def select_detections(self, boxes, best_scores, best_classes):
        np = self.np
        result = []
        indices = np.where((best_scores >= self.threshold) & (boxes[:, 2] > boxes[:, 0]) &
                           (boxes[:, 3] > boxes[:, 1]))[0]
        # Official demo uses class-agnostic suppression. One overlapping object
        # must not become both a car and a truck (and two counted tracks).
        for local_index in self._nms(boxes[indices], best_scores[indices]):
            index = indices[local_index]
            name = COCO_TARGETS.get(int(best_classes[index]))
            if name:
                result.append(Detection(name, float(min(1, best_scores[index])), tuple(float(v) for v in boxes[index])))
        return sorted(result, key=lambda d: d.confidence, reverse=True)[:300]
