#!/usr/bin/env python3
"""Crop a normalized object parquet (absolute frame_idx) to a wall-clock window and add local `frame` column.

Uses pyarrow:  python3 -m venv .venv-parquet && .venv-parquet/bin/pip install pyarrow

Example (match classification.json video_start_time_seconds=7200, 2:00–2:20 wall, 30 fps):
  .venv-parquet/bin/python scripts/crop_normalized_parquet_clip.py \\
    --input data/video_id=2726526327/composed_normalized_state.parquet \\
    --output data/video_id=2726526327/composed_normalized_state.sample.parquet \\
    --fps 30 --wall-start-seconds 7200 --wall-end-seconds 8400
"""

from __future__ import annotations

import argparse

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--input", required=True, help="Source parquet path")
    ap.add_argument("--output", required=True, help="Destination parquet (overwritten)")
    ap.add_argument("--fps", type=float, default=30.0)
    ap.add_argument("--wall-start-seconds", type=float, required=True)
    ap.add_argument("--wall-end-seconds", type=float, required=True)
    ap.add_argument("--frame-column", default="frame_idx")
    args = ap.parse_args()

    if args.wall_end_seconds <= args.wall_start_seconds:
        raise SystemExit("wall-end-seconds must be greater than wall-start-seconds")

    pf = pq.ParquetFile(args.input)
    table = pf.read()
    if args.frame_column not in table.column_names:
        raise SystemExit(f"Missing column {args.frame_column!r}; have {table.column_names}")

    fps = args.fps
    start_abs = int(round(args.wall_start_seconds * fps))
    end_abs_excl = int(round(args.wall_end_seconds * fps))
    last_inclusive = end_abs_excl - 1

    fc = table[args.frame_column]
    global_max = pc.max(fc).as_py()
    last_inclusive = min(last_inclusive, int(global_max))

    mask = pc.and_(pc.greater_equal(fc, pa.scalar(start_abs, type=fc.type)), pc.less_equal(fc, pa.scalar(last_inclusive, type=fc.type)))
    cropped = table.filter(mask)

    local = pc.subtract(cropped[args.frame_column], pa.scalar(start_abs, type=cropped[args.frame_column].type))
    out = cropped.append_column("frame", local.cast(pa.int32()))

    pq.write_table(out, args.output, compression="snappy")
    print(
        f"Wrote {args.output} rows={out.num_rows} "
        f"frame_idx=[{start_abs},{last_inclusive}] -> frame=[0,{last_inclusive - start_abs}]",
    )


if __name__ == "__main__":
    main()
