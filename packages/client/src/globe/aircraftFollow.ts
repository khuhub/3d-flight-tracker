import type { MotionTrack } from '@flight/shared';
import type { Camera, Vector3 } from 'three';

/** Keeps the camera on a rendered aircraft without a second motion calculation. */
export class AircraftFollow {
  private id: string | null = null;
  private tracks: readonly MotionTrack[] | null = null;
  private index = -1;

  private onChange?: (icao24: string | null) => void;

  setListener(listener: (icao24: string | null) => void): void {
    this.onChange = listener;
  }

  get targetId(): string | null {
    return this.id;
  }

  setTarget(icao24: string | null): void {
    if (this.id === icao24) return;
    this.id = icao24;
    this.tracks = null;
    this.onChange?.(icao24);
  }

  update(
    tracks: readonly MotionTrack[],
    positions: Float32Array,
    camera: Camera,
    orbitCenter: Vector3,
    distance: number,
  ): void {
    if (this.id === null) return;
    if (tracks !== this.tracks) {
      this.tracks = tracks;
      this.index = tracks.findIndex((track) => track.aircraft.icao24 === this.id);
    }
    // Leave the camera where it was while the same aircraft is absent.
    if (this.index < 0) return;
    camera.position.fromArray(positions, this.index * 3).setLength(distance);
    camera.lookAt(orbitCenter);
  }
}
