import { FormRequest } from '@elvel/http'

/**
 * Generated with `elvel make:request UploadAvatarRequest`, then extended.
 *
 * File rules against a real `multipart/form-data` body: Elysia hands the field
 * over as a web `File`, so there is no upload wrapper and no temporary path.
 *
 * `mimes` and `image` read the file's **bytes**, not the type the browser
 * claimed — a script renamed `avatar.png` arrives claiming `image/png`, and
 * nothing about the object contradicts it.
 */
export class UploadAvatarRequest extends FormRequest {
  rules() {
    return {
      // Kilobytes: `max:64` is 64KB, which is what everybody writing it means.
      avatar: 'required|image|mimes:png,jpg|max:64|dimensions:min_width=8,max_width=512',
      caption: 'sometimes|string|max:60'
    }
  }

  override messages() {
    return {
      'avatar.dimensions': 'The avatar must be between 8 and 512 pixels wide.'
    }
  }
}
