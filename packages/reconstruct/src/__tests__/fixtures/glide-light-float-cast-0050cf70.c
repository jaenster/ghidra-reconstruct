int32_t D2Glide::Renderer::Glide::RENDERER_GLIDE_DrawWallTilePerspective
                  (int nScreenXOffset,short *pSubtile,D2GlideVertexStrc *pfColorVertex,double dScale)

{
  D2GfxLightStrc fSubtileIndex;
  D2GfxLightStrc dwScaled;

  fSubtileIndex = (D2GfxLightStrc)((int)*pSubtile >> 5);
  if (4 < (uint)fSubtileIndex) {
    return 0;
  }
  fSubtileIndex = (D2GfxLightStrc)(float)nScreenXOffset;
  pfColorVertex->fX = (float)fSubtileIndex + pfColorVertex->fX;
  dwScaled = (D2GfxLightStrc)((double)nScreenXOffset * dScale);
  pfColorVertex->fY = (float)dwScaled + pfColorVertex->fY;
  return 1;
}
