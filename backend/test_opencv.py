import cv2
from image_processing import preprocess_image

image = preprocess_image(
    "invoice_Aaron Bergman_36258.pdf"
)

cv2.imshow(
    "Processed Image",
    image
)

cv2.waitKey(0)
cv2.destroyAllWindows()