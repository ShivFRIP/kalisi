// Response shapes of the Kalisi API (backend/kalisi/api/*.py). Times "HH:MM" are local (Asia/Kolkata);
// ISO strings are instants. Money is in paise unless the field says otherwise (fares are whole rupees).

export type Role = "rider" | "driver" | "ops";
export interface User { id: number; name: string; role: Role; phone: string; }
export interface ClockInfo { mode: "real" | "sim"; speed: number; now: string; timezone: string; }
export interface DemoAccount { role: Role; name: string; phone: string; note: string; }
export interface Place { name: string; kind: "office" | "area" | "metro"; lat: number; lon: number; }
export interface PlacesResponse { sources: Record<string, string>; places: Place[]; }
export interface LatLon { lat: number; lon: number; }

export interface Stop { id: number; name: string; lat: number; lon: number; kind: string; }

// ---------------- rider ----------------
export interface MatchOption {
  option_id: string; leg: "AM" | "PM"; template_id: number; route_code: string; route_name: string; express: boolean;
  pickup: Stop; drop: Stop; walk_to_pickup_m: number; walk_from_drop_m: number; depart: string; arrive: string;
  ride_min: number; road_km: number; fare: number; vehicle: string; seats: number; ac: boolean; seats_left: number; score: number;
}
export interface Intent {
  id: number; home: LatLon & { label: string }; office: LatLon & { label: string };
  am_from: string; am_to: string; pm_from: string | null; pm_to: string | null; days: number[];
  ac_only: boolean; max_walk_m: number; status: "pooled" | "matched" | "subscribed" | "paused"; campus_id: number | null;
}
export interface IntentIn {
  home: LatLon & { label: string }; office: LatLon & { label: string }; am_from: string; am_to: string;
  pm_from: string | null; pm_to: string | null; days: number[]; ac_only: boolean; max_walk_m: number;
}
export interface OptionsResponse {
  intent: Intent; am_options: MatchOption[]; pm_options: MatchOption[]; pooled: boolean; similar_nearby: number | null; credit_paise: number;
}
export interface Quote { weekly: number; monthly: number; credit_paise: number; }
export interface PassLeg { route_code: string; route_name: string; pickup: string; drop: string; fare: number; vehicle: string; }
export interface Pass {
  id: number; product: "monthly" | "weekly"; valid_from: string; valid_to: string; price_paise: number; paid_paise: number;
  status: string; days: number[]; am: PassLeg; pm: PassLeg | null;
}
export interface SkipTerms { allowed: boolean; on_time: boolean; credit_paise: number; deadline: string; note: string; }
export interface DayLeg {
  subscription_id: number; leg: "AM" | "PM"; route_code: string; pickup_time: string; pickup_stop: string;
  status: "scheduled" | "confirmed" | "skipped" | "boarded" | "completed" | "no_show" | "on_trip" | "missed";
  booking_id: number | null; trip_status: string | null; skip_id: number | null; skip_credit_paise: number;
  can_skip: boolean; can_undo: boolean; terms: SkipTerms;
}
export interface Day { date: string; weekday: string; legs: DayLeg[]; }
export interface LiveStop extends Stop { seq: number; planned: string; eta_from: string; eta_to: string; passed: boolean; action: string; }
export interface VehicleInfo { reg_no: string; class: string; seats: number; ac: boolean; }
export interface Position { lat: number; lon: number; heading: number | null; speed_kmh: number | null; ts: string; source: "sim" | "app"; }
export interface TripLive {
  trip_id: number; status: "planned" | "in_progress" | "completed" | "cancelled"; route_code: string; route_name: string;
  direction: string; service_date: string; planned_start: string; planned_end: string; delay_min: number; stops: LiveStop[];
  vehicle: VehicleInfo | null; driver: { first_name: string } | null; position: Position | null; booked: number;
  booking?: { id: number; status: string; boarding_code: string; leg: string; pickup: LiveStop; drop: LiveStop;
              minutes_to_pickup: number | null; km_to_pickup: number | null; };
}
export interface RiderHome {
  user: { id: number; name: string; phone: string }; credit_paise: number; passes: Pass[]; intent: Intent | null; days: Day[];
  current: TripLive | null; pending_rating: { booking_id: number; route_code: string; date: string; leg: string } | null; skip_cutoff: string;
}
export interface HistoryItem {
  booking_id: number; date: string; leg: string; route_code: string; pickup: string; drop: string; status: string; planned: string; pickup_time: string;
  rating: { driver: number; vehicle: number } | null;
}
export interface Wallet {
  credit_paise: number; credit_lines: { at: string; memo: string; paise: number }[];
  payments: { at: string; amount_paise: number; method: string; gateway: string; ref: string; status: string }[];
}
export const RATING_TAGS_GOOD = ["ac_working", "clean", "courteous_driver", "smooth_driving", "felt_safe", "on_time"] as const;
export const RATING_TAGS_BAD = ["ac_not_working", "dirty", "rash_driving", "felt_unsafe", "crowded", "rude"] as const;

// ---------------- driver ----------------
export interface DutyItemView {
  kind: "check" | "trip" | "deadhead" | "break"; start: string; end: string; km: number;
  trip_id?: number; route_code?: string; route_name?: string; direction?: string; status?: string; booked?: number; stops?: number;
  length?: "long" | "short";
}
export interface DutyView {
  duty_id: number; block: "FULL" | "AM" | "PM"; vehicle: VehicleInfo; depot: string; report: string; sign_off: string;
  worked_min: number; spread_min: number; deadhead_km: number; items: DutyItemView[];
}
export interface DriverToday { date: string; driver: { name: string; id: number }; duties: DutyView[]; }
export interface ManifestRider { booking_id: number; name: string; status: string; }
export interface DriverStop extends Stop {
  seq: number; action: string; planned: string; arrived: boolean; departed: boolean; no_show_allowed: boolean; board: ManifestRider[]; alight: ManifestRider[];
}
export interface DriverTrip {
  trip_id: number; route_code: string; route_name: string; direction: string; status: string; gps_source: "sim" | "app";
  delay_min: number; vehicle: { reg_no: string; class: string } | null; booked: number; boarded: number; stops: DriverStop[];
}
export type DriverEventType = "start" | "ping" | "arrive" | "depart" | "board" | "no_show" | "end";
export interface DriverEvent {
  client_event_id: string; trip_id: number; type: DriverEventType; stop_id?: number; seq?: number; booking_id?: number;
  code?: string; lat?: number; lon?: number; speed_kmh?: number; heading?: number; device_ts?: string;
}
export interface EventResult { client_event_id: string; status: "applied" | "duplicate" | "rejected"; reason?: string; }

// ---------------- ops ----------------
export interface Overview {
  date: string; now: string;
  trips: { scheduled: number; cancelled_no_bookings: number; in_progress: number; completed: number; unassigned: number };
  riders: { booked: number; boarded_or_done: number; no_show: number; skipped_after_cutoff: number };
  on_time_pct: number | null; load_factor_pct: number | null; vehicles_in_service: number; fleet: number; active_passes: number;
  pooled_riders: number; ratings: { driver_avg: number | null; vehicle_avg: number | null; count: number }; open_incidents: number; delayed_now: number;
}
export interface LiveVehicle {
  vehicle_id: number; reg_no: string; class: string; seats: number; lat: number; lon: number; heading: number | null; speed_kmh: number | null;
  source: string; trip_id: number | null; route_code: string | null; trip_status: string; delay_min: number;
  state: "idle" | "late" | "on_time"; boarded: number; booked: number;
}
export interface OpsException {
  kind: string; severity: "critical" | "high" | "normal"; title: string; detail: string; at?: string; incident_id?: number; trip_id?: number; duty_id?: number;
}
export interface RouteView {
  id: number; code: string; name: string; direction: string; status: "proposed" | "live" | "retired"; express: boolean; notes: string;
  campus: string | null;
  stops: { id: number; name: string; lat: number; lon: number; offset_min: number; action: string; kind: string; audited: boolean }[];
  departures: { template_id: number; start: string; vehicle: string; seats: number; sold: number; days_mask: number }[];
}
export interface AllocationSummary {
  date: string; departures_running: number; departures_cancelled_no_bookings: number; bookings: number; seats_offered: number;
  load_factor_pct: number; downsized: number; vehicles_used: number; fleet_size: number; vehicles_blocked: Record<string, string[]>;
  drivers_blocked: Record<string, string[]>; unassigned_departures: string[]; overflow_departures: string[]; duties: number;
  split_duties: number; duties_without_driver: number; deadhead_km: number;
}
export interface AllocationView {
  date: string;
  trips: { id: number; route_code: string; route_name: string; direction: string; start: string; end: string; status: string; booked: number;
           class: string; seats: number; vehicle: string | null; planned_class: string }[];
  duties: { id: number; vehicle: string; vehicle_class: string; block: string; driver: string | null; report: string; sign_off: string;
            worked_min: number; spread_min: number; deadhead_km: number;
            items: { kind: string; start: string; end: string; trip_id: number | null; route_code: string | null; booked: number | null; km: number }[] }[];
}
export interface FleetView {
  vehicles: { id: number; reg_no: string; operator: string; class: string; seats: number; ac: boolean; depot: string; status: string;
              documents: Record<string, string>; blocked: string[];
              duties_today: { block: string; driver: string | null; report: string; sign_off: string }[] }[];
  drivers: { id: number; name: string; phone: string; operator_id: number; operator: string; licence_valid_to: string; status: string; blocked: string[];
             rating: number | null; ratings: number; duty_today: { vehicle: string; block: string; report: string } | null }[];
}
export interface DemandView {
  k: number;
  hexes: { h3: string; boundary: [number, number][]; center: [number, number]; total: number; pooled: number; subscribed: number;
           top_campus: string; below_k: boolean }[];
  pooled_by_campus_time: { campus: string; arrive_from: string; riders: number }[];
}
export interface PlannerResult {
  pooled_riders: number; groups: number; unserved_riders: number;
  proposals: { code: string; return_code: string | null; campus: string; name: string; arrive: string; riders: number; vehicle: string;
               seats: number; load_pct: number; viable: boolean; ride_min: number; stops: string[] }[];
  groups_too_small: { campus: string; arrive: string; riders: number }[];
}
