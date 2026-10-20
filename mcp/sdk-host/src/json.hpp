#pragma once
#include "yyjson.h"
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <variant>
#include <vector>
#include <cmath>
#include <limits>

namespace umcp {
struct Json {
    using Object = std::map<std::string, Json>;
    using Array = std::vector<Json>;
    std::variant<std::nullptr_t, bool, int64_t, double, std::string, Array, Object> v{nullptr};
    Json() = default;
    Json(std::nullptr_t) {}
    Json(bool x):v(x){}
    Json(int x):v(int64_t(x)){}
    Json(int64_t x):v(x){}
    Json(double x):v(x){}
    Json(const char* x):v(std::string(x ? x : "")){}
    Json(std::string x):v(std::move(x)){}
    Json(Array x):v(std::move(x)){}
    Json(Object x):v(std::move(x)){}
    bool object() const { return std::holds_alternative<Object>(v); }
    bool array() const { return std::holds_alternative<Array>(v); }
    bool null() const { return std::holds_alternative<std::nullptr_t>(v); }
    const Json& get(const std::string& key) const {
        static const Json empty;
        if(!object()) return empty;
        auto& o=std::get<Object>(v); auto it=o.find(key); return it==o.end()?empty:it->second;
    }
    bool has(const std::string& key) const { return object() && std::get<Object>(v).count(key); }
    std::string str() const {
        if(!std::holds_alternative<std::string>(v)) throw std::runtime_error("expected_string");
        return std::get<std::string>(v);
    }
    std::string text(const std::string& key, const std::string& fallback="") const {
        return has(key)?get(key).str():fallback;
    }
    int64_t integer() const {
        if(!std::holds_alternative<int64_t>(v)) throw std::runtime_error("expected_integer");
        return std::get<int64_t>(v);
    }
    int number(const std::string& key,int fallback,int lo,int hi) const {
        auto n=has(key)?get(key).integer():fallback;
        if(n<lo||n>hi) throw std::runtime_error("integer_out_of_range:"+key);
        return static_cast<int>(n);
    }
    bool boolean(const std::string& key,bool fallback=false) const {
        if(!has(key)) return fallback;
        if(!std::holds_alternative<bool>(get(key).v)) throw std::runtime_error("expected_boolean:"+key);
        return std::get<bool>(get(key).v);
    }
    const Array& items() const {
        if(!array()) throw std::runtime_error("expected_array");
        return std::get<Array>(v);
    }
    static Json from(yyjson_val* x,int depth) {
        if(depth>32) throw std::runtime_error("json_depth_limit");
        if(yyjson_is_null(x)) return {};
        if(yyjson_is_bool(x)) return Json(yyjson_get_bool(x));
        if(yyjson_is_sint(x)) return Json(yyjson_get_sint(x));
        if(yyjson_is_uint(x)) {
            auto n=yyjson_get_uint(x); if(n>uint64_t(INT64_MAX)) throw std::runtime_error("integer_out_of_range");
            return Json(static_cast<int64_t>(n));
        }
        if(yyjson_is_real(x)) return Json(yyjson_get_real(x));
        if(yyjson_is_str(x)) {
            std::string s(yyjson_get_str(x),yyjson_get_len(x));
            if(s.find('\0')!=std::string::npos) throw std::runtime_error("embedded_nul");
            return Json(std::move(s));
        }
        if(yyjson_is_arr(x)) {
            Array a; size_t i,max; yyjson_val* e;
            yyjson_arr_foreach(x,i,max,e) { a.push_back(from(e,depth+1)); }
            return a;
        }
        if(yyjson_is_obj(x)) {
            Object o; size_t i,max; yyjson_val *k,*e;
            yyjson_obj_foreach(x,i,max,k,e) {
                auto key=from(k,depth+1).str();
                if(!o.emplace(key,from(e,depth+1)).second) throw std::runtime_error("duplicate_json_key");
            }
            return o;
        }
        throw std::runtime_error("invalid_json");
    }
    static Json parse(const std::string& s) {
        std::unique_ptr<yyjson_doc,decltype(&yyjson_doc_free)> doc(yyjson_read(s.data(),s.size(),0),yyjson_doc_free);
        if(!doc) throw std::runtime_error("invalid_json");
        return from(yyjson_doc_get_root(doc.get()),0);
    }
    yyjson_mut_val* to(yyjson_mut_doc* d) const {
        if(null()) return yyjson_mut_null(d);
        if(auto p=std::get_if<bool>(&v)) return yyjson_mut_bool(d,*p);
        if(auto p=std::get_if<int64_t>(&v)) return yyjson_mut_sint(d,*p);
        if(auto p=std::get_if<double>(&v)) return yyjson_mut_real(d,*p);
        if(auto p=std::get_if<std::string>(&v)) return yyjson_mut_strncpy(d,p->data(),p->size());
        if(auto p=std::get_if<Array>(&v)) { auto a=yyjson_mut_arr(d); for(auto& e:*p) yyjson_mut_arr_append(a,e.to(d)); return a; }
        auto o=yyjson_mut_obj(d); for(auto& [k,e]:std::get<Object>(v)) yyjson_mut_obj_add(o,yyjson_mut_strncpy(d,k.data(),k.size()),e.to(d)); return o;
    }
    std::string dump() const {
        std::unique_ptr<yyjson_mut_doc,decltype(&yyjson_mut_doc_free)> d(yyjson_mut_doc_new(nullptr),yyjson_mut_doc_free);
        if(!d) throw std::bad_alloc();
        yyjson_mut_doc_set_root(d.get(),to(d.get())); size_t n=0;
        char* p=yyjson_mut_write(d.get(),0,&n); if(!p) throw std::runtime_error("json_write_failed");
        std::unique_ptr<char,decltype(&free)> owned(p,free); return std::string(p,n);
    }
};
inline Json success(Json result) { return Json::Object{{"ok",true},{"result",std::move(result)}}; }
inline Json failure(const std::string& code) { return Json::Object{{"ok",false},{"error",code}}; }
}
