'use strict'

var semver = require('semver')
var debug = require('debug')('elastic-apm')
var shimmer = require('../shimmer')

module.exports = function (express, agent, version) {
  agent._platform.framework = { name: 'express', version: version }

  if (!semver.satisfies(version, '^4.0.0')) {
    debug('express version %s not supported - aborting...', version)
    return express
  }

  // express 5 moves the router methods onto a prototype
  var routerProto = semver.satisfies(version, '^5')
    ? (express.Router && express.Router.prototype)
    : express.Router

  var layerPatchedSymbol = Symbol('layer-patched')
  var reportedSymbol = Symbol('reported')
  function patchLayer (layer) {
    if (!layer[layerPatchedSymbol]) {
      layer[layerPatchedSymbol] = true
      debug('shimming express.Router.Layer.handle function')
      shimmer.wrap(layer, 'handle', function (orig) {
        if (orig.length !== 4) return orig
        return function (err, req, res, next) {
          if (!err[reportedSymbol]) {
            err[reportedSymbol] = true
            agent.captureError(err, { request: req })
          }
          return orig.apply(this, arguments)
        }
      })
    }
  }

  debug('shimming express.Router.process_params function')

  shimmer.wrap(routerProto, 'process_params', function (orig) {
    return function (layer, called, req, res, done) {
      patchLayer(layer)
      return orig.apply(this, arguments)
    }
  })

  debug('shimming express.Router.use function')

  // The `use` function is called when Express app or Router sub-app is
  // initialized. This is the only place where we can get a hold of the
  // original path given when mounting a sub-app.
  shimmer.wrap(routerProto, 'use', function (orig) {
    return function (fn) {
      if (typeof fn === 'string' && Array.isArray(this.stack)) {
        var offset = this.stack.length
        var result = orig.apply(this, arguments)
        var layer

        for (; offset < this.stack.length; offset++) {
          layer = this.stack[offset]

          if (layer && (fn !== '/' || (layer.regexp && !layer.regexp.fast_slash))) {
            debug('shimming layer.handle_request function (layer: %s)', layer.name)

            shimmer.wrap(layer, 'handle_request', function (orig) {
              return function (req, res, next) {
                if (req.route) {
                  // We use the signal of the route being set on the request
                  // object as indicating that the correct route have been
                  // found. When this happens we should no longer push and pop
                  // mount-paths on the stack
                  req._elastic_apm_mountstack_locked = true
                } else if (!req._elastic_apm_mountstack_locked && typeof next === 'function') {
                  if (!req._elastic_apm_mountstack) req._elastic_apm_mountstack = [fn]
                  else req._elastic_apm_mountstack.push(fn)

                  arguments[2] = function () {
                    req._elastic_apm_mountstack.pop()
                    return next.apply(this, arguments)
                  }
                }

                return orig.apply(this, arguments)
              }
            })
          } else {
            debug('skip shimming layer.handle_request (layer: %s, path: %s)', (layer && layer.name) || typeof layer, fn)
          }
        }

        return result
      } else {
        return orig.apply(this, arguments)
      }
    }
  })

  debug('shimming express.static function')

  shimmer.wrap(express, 'static', function wrapStatic (orig) {
    // By the time of this writing, Express adds a `mime` property to the
    // `static` function that needs to be copied to the wrapped function.
    // Instead of only copying the `mime` function, let's loop over all
    // properties in case new properties are added in later versions of
    // Express.
    Object.keys(orig).forEach(function (prop) {
      debug('copying property %s from express.static', prop)
      wrappedStatic[prop] = orig[prop]
    })

    return wrappedStatic

    function wrappedStatic () {
      var origServeStatic = orig.apply(this, arguments)
      return function serveStatic (req, res, next) {
        req._elastic_apm_static = true

        return origServeStatic(req, res, nextHook)

        function nextHook (err) {
          if (!err) req._elastic_apm_static = false
          return next.apply(this, arguments)
        }
      }
    }
  })

  return express
}
