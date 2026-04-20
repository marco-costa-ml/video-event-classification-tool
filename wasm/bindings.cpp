#include <emscripten/bind.h>
#include <nlohmann/json.hpp>

using json = nlohmann::json;

namespace {

json get_field(const json& state, const json& expr);

json dedupe_events(const json& events, int merge_window) {
  if (!events.is_array()) return json::array();
  std::vector<json> sorted = events.get<std::vector<json>>();
  std::sort(sorted.begin(), sorted.end(), [](const json& a, const json& b) {
    return a.value("start_frame", 0) < b.value("start_frame", 0);
  });
  json out = json::array();
  for (const auto& ev : sorted) {
    if (ev.value("kind", "") != "point") {
      out.push_back(ev);
      continue;
    }
    if (!out.empty()) {
      const auto& prev = out.back();
      if (prev.value("kind", "") == "point" &&
          prev.value("event_name", "") == ev.value("event_name", "") &&
          ev.value("start_frame", 0) - prev.value("start_frame", 0) <= merge_window) {
        continue;
      }
    }
    out.push_back(ev);
  }
  return out;
}

json resolve_expr(const json& state, const json& expr) {
  const std::string kind = expr.value("kind", "");
  if (kind == "literal") return expr["value"];
  if (kind == "field") return get_field(state, expr);
  return json();
}

json get_field(const json& state, const json& expr) {
  const json* cur = &state;
  if (!expr.contains("path") || !expr["path"].is_array()) return json();
  for (const auto& seg : expr["path"]) {
    if (seg.is_string()) {
      const std::string k = seg.get<std::string>();
      if (!cur->is_object() || !cur->contains(k)) return json();
      cur = &(*cur)[k];
    } else if (seg.is_number_integer()) {
      const int idx = seg.get<int>();
      if (!cur->is_array() || idx < 0 || idx >= static_cast<int>(cur->size())) return json();
      cur = &(*cur)[idx];
    } else {
      return json();
    }
  }
  return *cur;
}

bool eval_comparison(const json& state, const json& node) {
  const auto left = resolve_expr(state, node.at("left"));
  const auto right = resolve_expr(state, node.at("right"));
  const std::string op = node.value("op", "==");
  if (op == "==") return left == right;
  if (op == "!=") return left != right;
  if (op == ">" || op == "<" || op == ">=" || op == "<=") {
    if (!left.is_number() || !right.is_number()) return false;
    const double l = left.get<double>();
    const double r = right.get<double>();
    if (op == ">") return l > r;
    if (op == "<") return l < r;
    if (op == ">=") return l >= r;
    if (op == "<=") return l <= r;
  }
  if (op == "contains") {
    return left.is_string() && right.is_string() &&
           left.get<std::string>().find(right.get<std::string>()) != std::string::npos;
  }
  if (op == "not_contains") {
    return !(left.is_string() && right.is_string() &&
             left.get<std::string>().find(right.get<std::string>()) != std::string::npos);
  }
  if (op == "in") {
    if (!right.is_array()) return false;
    for (const auto& v : right) {
      if (v == left) return true;
    }
    return false;
  }
  if (op == "not_in") {
    if (!right.is_array()) return true;
    for (const auto& v : right) {
      if (v == left) return false;
    }
    return true;
  }
  return false;
}

bool eval_predicate(const json& state, const json& node) {
  const std::string kind = node.value("kind", "");
  if (kind == "logical") {
    const std::string op = node.value("op", "and");
    const auto& ch = node["children"];
    if (!ch.is_array()) return false;
    if (op == "not") {
      if (ch.empty()) return true;
      return !eval_predicate(state, ch[0]);
    }
    if (op == "and") {
      for (const auto& c : ch) {
        if (!eval_predicate(state, c)) return false;
      }
      return true;
    }
    for (const auto& c : ch) {
      if (eval_predicate(state, c)) return true;
    }
    return false;
  }
  if (kind == "comparison") return eval_comparison(state, node);
  if (kind == "exists") {
    json fake;
    fake["kind"] = "field";
    fake["path"] = node["path"];
    const auto v = get_field(state, fake);
    return !v.is_null();
  }
  if (kind == "not_exists") {
    json fake;
    fake["kind"] = "field";
    fake["path"] = node["path"];
    const auto v = get_field(state, fake);
    return v.is_null();
  }
  return false;
}

}  // namespace

std::string dedupe_events_json(std::string input_json, int merge_window) {
  try {
    const auto j = json::parse(input_json);
    return dedupe_events(j, merge_window).dump();
  } catch (...) {
    return "[]";
  }
}

int eval_predicate_json(std::string state_json, std::string predicate_json) {
  try {
    const auto st = json::parse(state_json);
    const auto pr = json::parse(predicate_json);
    return eval_predicate(st, pr) ? 1 : 0;
  } catch (...) {
    return 0;
  }
}

std::string engine_version() { return std::string("tec_engine_wasm_0.1"); }

EMSCRIPTEN_BINDINGS(tec_engine) {
  emscripten::function("dedupeEventsJson", &dedupe_events_json);
  emscripten::function("evalPredicateJson", &eval_predicate_json);
  emscripten::function("version", &engine_version);
}
