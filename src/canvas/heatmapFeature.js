var inherit = require('../inherit');
var registerFeature = require('../registry').registerFeature;
var heatmapFeature = require('../heatmapFeature');
var timestamp = require('../timestamp');

//////////////////////////////////////////////////////////////////////////////
/**
 * Create a new instance of class heatmapFeature
 * Inspired from
 *    https://github.com/mourner/simpleheat/blob/gh-pages/simpleheat.js
 *
 * @class geo.canvas.heatmapFeature
 * @param {Object} arg Options object
 * @extends geo.heatmapFeature
 * @returns {canvas_heatmapFeature}
 */
//////////////////////////////////////////////////////////////////////////////
var canvas_heatmapFeature = function (arg) {
  'use strict';

  if (!(this instanceof canvas_heatmapFeature)) {
    return new canvas_heatmapFeature(arg);
  }
  heatmapFeature.call(this, arg);
  var object = require('./object');

  object.call(this);

  ////////////////////////////////////////////////////////////////////////////
  /**
   * @private
   */
  ////////////////////////////////////////////////////////////////////////////
  var geo_event = require('../event');

  var m_this = this,
      m_typedBuffer,
      m_typedClampedBuffer,
      m_typedBufferData,
      m_heatMapPosition,
      s_exit = this._exit,
      s_init = this._init,
      s_update = this._update,
      m_renderTime = timestamp();

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Meta functions for converting from geojs styles to canvas.
   * @private
   */
  ////////////////////////////////////////////////////////////////////////////
  this._convertColor = function (c) {
    var color;
    if (c.hasOwnProperty('r') &&
      c.hasOwnProperty('g') &&
      c.hasOwnProperty('b') &&
      c.hasOwnProperty('a')) {
      color = 'rgba(' + 255 * c.r + ',' + 255 * c.g + ','
                    + 255 * c.b + ',' + c.a + ')';
    }
    return color;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Compute gradient (color lookup table)
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._computeGradient = function () {
    var canvas, stop, context2d, gradient, colors;

    colors = m_this.style('color');
    if (!m_this._grad || m_this._gradColors !== colors) {
      canvas = document.createElement('canvas');
      context2d = canvas.getContext('2d');
      gradient = context2d.createLinearGradient(0, 0, 0, 256);

      canvas.width = 1;
      canvas.height = 256;

      for (stop in colors) {
        gradient.addColorStop(stop, m_this._convertColor(colors[stop]));
      }

      context2d.fillStyle = gradient;
      context2d.fillRect(0, 0, 1, 256);
      m_this._grad = context2d.getImageData(0, 0, 1, 256).data;
      m_this._gradColors = colors;
    }

    return m_this;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Create circle for each data point
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._createCircle = function () {
    var circle, ctx, r, r2, blur, gaussian;
    r = m_this.style('radius');
    blur = m_this.style('blurRadius');
    gaussian = m_this.style('gaussian');
    if (!m_this._circle || m_this._circle.gaussian !== gaussian ||
        m_this._circle.radius !== r || m_this._circle.blurRadius !== blur) {
      circle = m_this._circle = document.createElement('canvas');
      ctx = circle.getContext('2d');
      r2 = blur + r;
      circle.width = circle.height = r2 * 2;
      if (!gaussian) {
        ctx.shadowOffsetX = ctx.shadowOffsetY = r2 * 2;
        ctx.shadowBlur = blur;
        ctx.shadowColor = 'black';
        ctx.beginPath();
        ctx.arc(-r2, -r2, r, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.fill();
      } else {
        /* This approximates a gaussian distribution by using a 10-step
         * piecewise linear radial gradient.  Strictly, it should not stop at
         * the radius, but should be attenuated further.  The scale has been
         * selected such that the values at the radius are around 1/256th of
         * the maximum, and therefore would not be visible using an 8-bit alpha
         * channel for the summation.  The values for opacity were generated by
         * the python expression:
         *   from scipy.stats import norm
         *   for r in [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]:
         *     opacity = norm.pdf(r, scale=0.3) / norm.pdf(0, scale=0.3)
         * Usng a 10-interval approximation is accurate to within 0.5% of the
         * actual Gaussian magnitude.  Switching to a 20-interval approximation
         * would get within 0.1%, at which point there is more error from using
         * a Gaussian truncated at the radius than from the approximation.
         */
        var grad = ctx.createRadialGradient(r2, r2, 0, r2, r2, r2);
        grad.addColorStop(0.0, 'rgba(255,255,255,1)');
        grad.addColorStop(0.1, 'rgba(255,255,255,0.946)');
        grad.addColorStop(0.2, 'rgba(255,255,255,0.801)');
        grad.addColorStop(0.3, 'rgba(255,255,255,0.607)');
        grad.addColorStop(0.4, 'rgba(255,255,255,0.411)');
        grad.addColorStop(0.5, 'rgba(255,255,255,0.249)');
        grad.addColorStop(0.6, 'rgba(255,255,255,0.135)');
        grad.addColorStop(0.7, 'rgba(255,255,255,0.066)');
        grad.addColorStop(0.8, 'rgba(255,255,255,0.029)');
        grad.addColorStop(0.9, 'rgba(255,255,255,0.011)');
        grad.addColorStop(1.0, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, r2 * 2, r2 * 2);
      }
      circle.radius = r;
      circle.blurRadius = blur;
      circle.gaussian = gaussian;
      m_this._circle = circle;
    }
    return m_this;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Compute color for each pixel on the screen
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._colorize = function (pixels, gradient) {
    var grad = new Uint32Array(gradient.buffer),
        pixlen = pixels.length,
        i, j, k;
    if (!m_typedBuffer || m_typedBuffer.length !== pixlen) {
      m_typedBuffer = new ArrayBuffer(pixlen);
      m_typedClampedBuffer = new Uint8ClampedArray(m_typedBuffer);
      m_typedBufferData = new Uint32Array(m_typedBuffer);
    }
    for (i = 3, k = 0; i < pixlen; i += 4, k += 1) {
      // Get opacity from the temporary canvas image and look up the final
      // value from gradient
      j = pixels[i];
      if (j) {
        m_typedBufferData[k] = grad[j];
      }
    }
    pixels.set(m_typedClampedBuffer);
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Render individual data points on the canvas.
   * @protected
   * @param {object} context2d the canvas context to draw in.
   * @param {object} map the parent map object.
   * @param {Array} data the main data array.
   * @param {number} radius the sum of radius and blurRadius.
   */
  ////////////////////////////////////////////////////////////////////////////
  this._renderPoints = function (context2d, map, data, radius) {
    var position = m_this.gcsPosition(),
        intensityFunc = m_this.intensity(),
        minIntensity = m_this.minIntensity(),
        rangeIntensity = (m_this.maxIntensity() - minIntensity) || 1,
        idx, pos, intensity;

    for (idx = data.length - 1; idx >= 0; idx -= 1) {
      pos = map.worldToDisplay(position[idx]);
      intensity = (intensityFunc(data[idx]) - minIntensity) / rangeIntensity;
      if (intensity <= 0) {
        continue;
      }
      // Small values are not visible because globalAlpha < .01
      // cannot be read from imageData
      context2d.globalAlpha = intensity < 0.01 ? 0.01 : (intensity > 1 ? 1 : intensity);
      context2d.drawImage(m_this._circle, pos.x - radius, pos.y - radius);
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Render data points on the canvas by binning.
   * @protected
   * @param {object} context2d the canvas context to draw in.
   * @param {object} map the parent map object.
   * @param {Array} data the main data array.
   * @param {number} radius the sum of radius and blurRadius.
   * @param {number} binSize size of the bins in pixels.
   */
  ////////////////////////////////////////////////////////////////////////////
  this._renderBinnedData = function (context2d, map, data, radius, binSize) {
    var position = m_this.gcsPosition(),
        intensityFunc = m_this.intensity(),
        minIntensity = m_this.minIntensity(),
        rangeIntensity = (m_this.maxIntensity() - minIntensity) || 1,
        viewport = map.camera()._viewport,
        bins = [],
        rw = Math.ceil(radius / binSize),
        maxx = Math.ceil(viewport.width / binSize) + rw * 2 + 2,
        maxy = Math.ceil(viewport.height / binSize) + rw * 2 + 2,
        datalen = data.length,
        idx, pos, intensity, x, y, binrow, offsetx, offsety;

    /* We create bins of size (binSize) pixels on a side.  We only track bins
     * that are on the viewport or within the radius of it, plus one extra bin
     * width. */
    for (idx = 0; idx < datalen; idx += 1) {
      pos = map.worldToDisplay(position[idx]);
      /* To make the results look more stable, we use the first data point as a
       * hard-reference to where the bins should line up.  Otherwise, as we pan
       * points would shift which bin they are in and the display would ripple
       * oddly. */
      if (isNaN(pos.x) || isNaN(pos.y)) {
        continue;
      }
      if (offsetx === undefined) {
        offsetx = ((pos.x % binSize) + binSize) % binSize;
        offsety = ((pos.y % binSize) + binSize) % binSize;
      }
      /* We handle points that are in the viewport, plus the radius on either
       * side, as they will add into the visual effect, plus one additional bin
       * to account for the offset alignment. */
      x = Math.floor((pos.x - offsetx) / binSize) + rw + 1;
      if (x < 0 || x >= maxx) {
        continue;
      }
      y = Math.floor((pos.y - offsety) / binSize) + rw + 1;
      if (y < 0 || y >= maxy) {
        continue;
      }
      intensity = (intensityFunc(data[idx]) - minIntensity) / rangeIntensity;
      if (intensity <= 0) {
        continue;
      }
      if (intensity > 1) {
        intensity = 1;
      }
      /* bins is an array of arrays.  The subarrays would be conceptually
       * better represented as an array of dicts, but having a sparse array is
       * uses much less memory and is faster.  Each bin uses four array entries
       * that are (weight, intensity, x, y).  The weight is the sum of the
       * intensities for all points in the bin.  The intensity is the geometric
       * sum of the intensities to approximate what happens to the unbinned
       * data on the alpha channel of the canvas.  The x and y coordinates are
       * weighted by the intensity of each point. */
      bins[y] = bins[y] || [];
      x *= 4;
      binrow = bins[y];
      if (!binrow[x]) {
        binrow[x] = binrow[x + 1] = intensity;
        binrow[x + 2] = pos.x * intensity;
        binrow[x + 3] = pos.y * intensity;
      } else {
        binrow[x] += intensity;  // weight
        binrow[x + 1] += (1 - binrow[x + 1]) * intensity;
        binrow[x + 2] += pos.x * intensity;
        binrow[x + 3] += pos.y * intensity;
      }
    }
    /* For each bin, render a point on the canvas. */
    for (y = bins.length - 1; y >= 0; y -= 1) {
      binrow = bins[y];
      if (binrow) {
        for (x = binrow.length - 4; x >= 0; x -= 4) {
          if (binrow[x]) {
            intensity = binrow[x + 1];
            context2d.globalAlpha = intensity < 0.01 ? 0.01 : (intensity > 1 ? 1 : intensity);
            /* The position is eighted by the intensities, so we have to divide
             * it to get the necessary position */
            context2d.drawImage(
              m_this._circle,
              binrow[x + 2] / binrow[x] - radius,
              binrow[x + 3] / binrow[x] - radius);
          }
        }
      }
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Render the data on the canvas, then colorize the resulting opacity map.
   * @protected
   * @param {object} context2d the canvas context to draw in.
   * @param {object} map the parent map object.
   */
  ////////////////////////////////////////////////////////////////////////////
  this._renderOnCanvas = function (context2d, map) {

    if (m_renderTime.getMTime() < m_this.buildTime().getMTime()) {
      var data = m_this.data() || [],
          radius = m_this.style('radius') + m_this.style('blurRadius'),
          binned = m_this.binned(),
          canvas, pixelArray,
          layer = m_this.layer(),
          viewport = map.camera()._viewport;

      /* Determine if we should bin the data */
      if (binned === true || binned === 'auto') {
        binned = Math.max(Math.floor(radius / 8), 3);
        if (m_this.binned() === 'auto') {
          var numbins = (Math.ceil((viewport.width + radius * 2) / binned) *
                         Math.ceil((viewport.height + radius * 2) / binned));
          if (numbins >= data.length) {
            binned = 0;
          }
        }
      }
      if (binned < 1 || isNaN(binned)) {
        binned = false;
      }
      /* Store what we did, in case this is ever useful elsewhere */
      m_this._binned = binned;

      context2d.setTransform(1, 0, 0, 1, 0, 0);
      context2d.clearRect(0, 0, viewport.width, viewport.height);
      layer.canvas().css({transform: '', 'transform-origin': '0px 0px'});

      m_this._createCircle();
      m_this._computeGradient();
      if (!binned) {
        m_this._renderPoints(context2d, map, data, radius);
      } else {
        m_this._renderBinnedData(context2d, map, data, radius, binned);
      }
      canvas = layer.canvas()[0];
      pixelArray = context2d.getImageData(0, 0, canvas.width, canvas.height);
      m_this._colorize(pixelArray.data, m_this._grad);
      context2d.putImageData(pixelArray, 0, 0);

      m_heatMapPosition = {
        zoom: map.zoom(),
        gcsOrigin: map.displayToGcs({x: 0, y: 0}, null),
        rotation: map.rotation(),
        lastScale: undefined,
        lastOrigin: {x: 0, y: 0},
        lastRotation: undefined
      };
      m_renderTime.modified();
      layer.renderer().clearCanvas(false);
    }

    return m_this;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Initialize
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._init = function () {
    s_init.call(m_this, arg);

    m_this.geoOn(geo_event.pan, m_this._animatePan);

    return m_this;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Update
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._update = function () {
    s_update.call(m_this);
    if (m_this.buildTime().getMTime() <= m_this.dataTime().getMTime() ||
        m_this.updateTime().getMTime() < m_this.getMTime()) {
      m_this._build();
    }
    m_this.updateTime().modified();
    return m_this;
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Animate pan (and zoom)
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._animatePan = function (e) {

    var map = m_this.layer().map(),
        zoom = map.zoom(),
        scale = Math.pow(2, (zoom - m_heatMapPosition.zoom)),
        origin = map.gcsToDisplay(m_heatMapPosition.gcsOrigin, null),
        rotation = map.rotation();

    if (m_heatMapPosition.lastScale === scale &&
        m_heatMapPosition.lastOrigin.x === origin.x &&
        m_heatMapPosition.lastOrigin.y === origin.y &&
        m_heatMapPosition.lastRotation === rotation) {
      return;
    }

    var transform = '' +
        ' translate(' + origin.x + 'px' + ',' + origin.y + 'px' + ')' +
        ' scale(' + scale + ')' +
        ' rotate(' + ((rotation - m_heatMapPosition.rotation) * 180 / Math.PI) + 'deg)';

    m_this.layer().canvas()[0].style.transform = transform;

    m_heatMapPosition.lastScale = scale;
    m_heatMapPosition.lastOrigin.x = origin.x;
    m_heatMapPosition.lastOrigin.y = origin.y;
    m_heatMapPosition.lastRotation = rotation;

    if (m_heatMapPosition.timeout) {
      window.clearTimeout(m_heatMapPosition.timeout);
      m_heatMapPosition.timeout = undefined;
    }
    /* This conditional can change if we compute the heatmap beyond the visable
     * viewport so that we don't have to update on pans as often.  If we are
     * close to where the heatmap was originally computed, don't bother
     * updating it. */
    if (parseFloat(scale.toFixed(4)) !== 1 ||
        parseFloat((rotation - m_heatMapPosition.rotation).toFixed(4)) !== 0 ||
        parseFloat(origin.x.toFixed(1)) !== 0 ||
        parseFloat(origin.y.toFixed(1)) !== 0) {
      m_heatMapPosition.timeout = window.setTimeout(function () {
        m_heatMapPosition.timeout = undefined;
        m_this.buildTime().modified();
        m_this.layer().draw();
      }, m_this.updateDelay());
    }
  };

  ////////////////////////////////////////////////////////////////////////////
  /**
   * Destroy
   * @protected
   */
  ////////////////////////////////////////////////////////////////////////////
  this._exit = function () {
    s_exit.call(m_this);
  };

  m_this._init(arg);
  return this;
};

inherit(canvas_heatmapFeature, heatmapFeature);

// Now register it
registerFeature('canvas', 'heatmap', canvas_heatmapFeature);
module.exports = canvas_heatmapFeature;
