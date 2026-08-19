import { FormRequest } from '@elvel/http'

/**
 * Generated with `elvel make:request StoreOrderRequest`, then extended.
 *
 * An order with a variable number of lines: the case wildcard rules exist for.
 * Every rule below names a *pattern*, and one rule per line is what actually
 * runs — so an error is reported against `lines.1.quantity`, which is the field
 * a form can put the message next to.
 */
export class StoreOrderRequest extends FormRequest {
  rules() {
    return {
      reference: 'required|string|min:3',

      // The collection itself, so an empty or missing one is reported once,
      // against `lines`, rather than as nothing at all.
      lines: 'required|array|min:1',

      'lines.*.sku': 'required|string|distinct',
      'lines.*.quantity': 'required|integer|min:1',
      'lines.*.price': 'required|numeric|min:0',

      // Named keys: an unexpected one is a failure rather than something quietly
      // carried into validated().
      'lines.*.options': 'sometimes|array:colour,size',

      tags: 'sometimes|list',
      'tags.*': 'string|distinct:ignore_case'
    }
  }

  override messages() {
    return {
      // Written against the pattern; found from `lines.0.quantity`.
      'lines.*.quantity.min': 'Line :position must order at least one unit.',
      'lines.*.sku.distinct': 'Line :position repeats a SKU.'
    }
  }

  override attributes() {
    return { 'lines.*.price': 'line price' }
  }
}
